/**
 * Programmatic Next.js HTTP server with a WebSocket upgrade path for
 * interactive app PTYs (`node-pty` + `@xterm/xterm` in the browser).
 *
 * Non-PTY upgrades are delegated to `next.getUpgradeHandler()` so dev
 * HMR / Turbopack keep working. Started via `package.json` `dev` / `start`
 * (see `bun scripts/run.ts … node --import tsx ./scripts/bridge-http-server.ts`).
 *
 * Requires **Node.js** (not Bun) at runtime: `node-pty` ships native
 * bindings built for the Node ABI.
 */
import { createServer, type IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import type { Duplex } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import next from "next";
import pty, { type IPty } from "node-pty";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DEMO_MODE } from "../libs/demoMode";
import { execLocked, filterPtyStdinChunk } from "../libs/appExecGuard";
import { INTERNAL_TOKEN_HEADER } from "../libs/auth";
import { authorizePtyUpgrade } from "../libs/ptyWsAuth";
import { resolveAppFromRouteSegment } from "../libs/apps";
import { stampServerAuthoredHeaders } from "../libs/peerAddr";

const PTY_PATH = "/api/apps/ws-pty";

function headerGet(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function rejectUpgrade(socket: Duplex, code: number, reason: string, log?: string) {
  if (log) console.warn(`[bridge] PTY WS upgrade → HTTP ${code}: ${log}`);
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function spawnBridgePty(
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
): IPty {
  const base = { name: "xterm-256color" as const, cols, rows, cwd, env };
  if (process.platform === "win32") {
    const psPath = join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const tries: Array<{ file: string; args: string[] }> = [];
    if (existsSync(psPath)) tries.push({ file: psPath, args: ["-NoLogo"] });
    tries.push({ file: "powershell.exe", args: ["-NoLogo"] });
    tries.push({ file: process.env.ComSpec || "cmd.exe", args: [] });
    let lastErr: unknown;
    for (const t of tries) {
      try {
        return pty.spawn(t.file, t.args, base);
      } catch (e) {
        lastErr = e;
        console.warn(`[bridge] PTY spawn failed (${t.file}):`, (e as Error).message);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  const shell = process.env.SHELL || "/bin/bash";
  return pty.spawn(shell, [], base);
}

function parseClientMessage(raw: RawData): { t: string; d?: string; c?: number; r?: number } | null {
  const str = typeof raw === "string" ? raw : raw.toString("utf8");
  try {
    const msg = JSON.parse(str) as { t?: string; d?: string; c?: number; r?: number };
    if (typeof msg.t !== "string") return null;
    return { t: msg.t, d: msg.d, c: msg.c, r: msg.r };
  } catch {
    return null;
  }
}

function attachPty(ws: InstanceType<typeof WebSocket>, cwd: string) {
  const ptyStdinRoll = { buf: "" };

  let cols = 80;
  let rows = 24;
  const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;

  let child: IPty;
  try {
    child = spawnBridgePty(cwd, cols, rows, env);
  } catch (e) {
    console.error("[bridge] PTY spawn failed after all fallbacks:", e);
    try {
      ws.close(1011, "pty spawn failed");
    } catch {
      /* ignore */
    }
    return;
  }

  const onData = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: false });
  };
  child.onData(onData);

  child.onExit((ev) => {
    if (ws.readyState === WebSocket.OPEN) {
      const hint =
        ev.signal !== undefined ? `signal ${ev.signal}` : `code ${ev.exitCode ?? "?"}`;
      ws.send(`\r\n\x1b[90m[process exited: ${hint}]\x1b[0m\r\n`);
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  ws.on("message", (data) => {
    const msg = parseClientMessage(data);
    if (!msg) return;
    if (msg.t === "in" && typeof msg.d === "string") {
      const gate = filterPtyStdinChunk(ptyStdinRoll, msg.d);
      if (!gate.ok) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\r\n\x1b[33m[bridge: ${gate.reason}]\x1b[0m\r\n`);
        }
        return;
      }
      try {
        child.write(msg.d);
      } catch {
        /* pty may be dead */
      }
      return;
    }
    if (msg.t === "resize" && typeof msg.c === "number" && typeof msg.r === "number") {
      cols = Math.max(2, Math.min(512, Math.floor(msg.c)));
      rows = Math.max(1, Math.min(256, Math.floor(msg.r)));
      try {
        child.resize(cols, rows);
      } catch {
        /* ignore */
      }
    }
  });

  ws.on("close", () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });
}

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  // Never use `process.env.HOSTNAME` for HTTP bind: on Windows (Git Bash,
  // cmd, PowerShell) it is always the computer name. Node then listens on
  // that host's resolved address, not loopback — `http://localhost:PORT`
  // connection-refuses while `http://<PC-NAME>:PORT` works.
  const hostname =
    process.env.BRIDGE_HOST?.trim() ||
    process.env.HOST?.trim() ||
    "0.0.0.0";
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const app = next({ dev, hostname, port, dir: process.cwd() });
  const handle = app.getRequestHandler();
  await app.prepare();
  const nextUpgrade = app.getUpgradeHandler();

  const ptyWss = new WebSocketServer({ noServer: true });

  // Marker the API route checks. Set BEFORE the handler attaches so the
  // ticket route can warn the client when it's mis-served by plain
  // `next dev` (which has no `/api/apps/ws-pty` upgrade handler — the
  // browser then sees a hung handshake = WebSocket close 1006).
  process.env.BRIDGE_PTY_READY = "1";

  const server = createServer((req, res) => {
    // Stamp the server-authored same-host signals proxy.ts's internal-
    // token gate relies on (PEER_ADDR_HEADER, CLIENT_FORWARDED_FOR_HEADER)
    // — deleting any client-supplied copy of either first. See
    // `stampServerAuthoredHeaders`'s doc comment in libs/peerAddr.ts for
    // why this has to happen here, before `handle()` runs, and why it's
    // pulled into its own function rather than left inline (audit H2).
    stampServerAuthoredHeaders(req);
    const parsed = parseUrl(req.url || "", true);
    void handle(req, res, parsed);
  });

  server.on("upgrade", (req, socket, head) => {
    // NOTE: deliberately no `stampServerAuthoredHeaders(req)` call here.
    // `authorizePtyUpgrade` (below) never reads PEER_ADDR_HEADER,
    // CLIENT_FORWARDED_FOR_HEADER, or the internal token, so there is no
    // signal here for a spoof to corrupt. Safe ONLY because this upgrade
    // path never reaches `proxy.ts` / Next middleware (`ptyWss.handleUpgrade`
    // below bypasses `handle()` entirely) — a future upgrade handler that
    // DOES delegate to Next middleware would need the same stamp this
    // callback applies, or it inherits H2 all over again.
    const pathname = parseUrl(req.url || "", true).pathname || "";
    if (pathname !== PTY_PATH) {
      void nextUpgrade(req, socket, head);
      return;
    }

    if (DEMO_MODE) {
      rejectUpgrade(socket, 503, "Service Unavailable", "BRIDGE_DEMO_MODE");
      return;
    }
    if (execLocked()) {
      rejectUpgrade(socket, 403, "Forbidden", "BRIDGE_LOCK_EXEC=1");
      return;
    }

    const q = parseUrl(req.url || "", true).query;
    const rawApp = q.app;
    const appSeg = Array.isArray(rawApp) ? rawApp[0] : rawApp;
    if (typeof appSeg !== "string" || !appSeg.trim()) {
      rejectUpgrade(socket, 400, "Bad Request", "missing app query");
      return;
    }

    // Cookie or one-time ticket only — the raw internal token is
    // deliberately NOT accepted here (see authorizePtyUpgrade's header
    // comment, audit C5). This listener runs on raw node:http and never
    // passes through proxy.ts's same-host gate, so honouring the token
    // would hand an interactive shell to anyone holding it — and every
    // spawned child carries it in its env. The ticket is accepted ONLY
    // via the query string (it's single-use and short-lived, unlike the
    // token) since WS upgrade requests from the browser can't set custom
    // headers.
    const rawTicket =
      typeof q.ticket === "string"
        ? q.ticket
        : Array.isArray(q.ticket)
          ? q.ticket[0]
          : undefined;
    const authz = authorizePtyUpgrade({
      cookieHeader: req.headers.cookie,
      internalTokenHeader: headerGet(req, INTERNAL_TOKEN_HEADER) ?? undefined,
      ticket: rawTicket,
    });
    if (!authz.ok) {
      rejectUpgrade(
        socket,
        401,
        "Unauthorized",
        `${authz.reason} (cookie header ${req.headers.cookie ? "present" : "missing"}; the internal token is no longer accepted on this path — non-cookie clients must POST /api/apps/pty-ws-ticket first and pass ?ticket= on the WS URL)`,
      );
      return;
    }

    const resolved = resolveAppFromRouteSegment(decodeURIComponent(appSeg));
    if (!resolved) {
      rejectUpgrade(socket, 404, "Not Found", `unknown app segment`);
      return;
    }
    if (!existsSync(resolved.path)) {
      rejectUpgrade(socket, 404, "Not Found", `cwd missing: ${resolved.path}`);
      return;
    }

    try {
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        try {
          attachPty(ws, resolved.path);
        } catch (e) {
          console.error("[bridge] attachPty error:", e);
          try {
            ws.close(1011, "attach failed");
          } catch {
            /* ignore */
          }
        }
      });
    } catch (e) {
      console.error("[bridge] WebSocket handleUpgrade error:", e);
      rejectUpgrade(socket, 500, "Internal Server Error", (e as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, hostname === "0.0.0.0" ? undefined : hostname, () => resolve());
    server.on("error", reject);
  });

  const hostLabel = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`[bridge] ready on http://${hostLabel}:${port} (PTY WS at ${PTY_PATH})`);
}

main().catch((err) => {
  console.error("[bridge] server failed to start:", err);
  process.exit(1);
});
