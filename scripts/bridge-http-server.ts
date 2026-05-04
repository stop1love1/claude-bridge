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
import { INTERNAL_TOKEN_HEADER, verifyRequestAuthOrInternal } from "../libs/auth";
import { consumePtyWsTicket } from "../libs/ptyWsTickets";
import { resolveAppFromRouteSegment } from "../libs/apps";

const PTY_PATH = "/api/apps/ws-pty";

function cookiesFromHeader(header: string | undefined): {
  get(name: string): { value: string } | undefined;
} {
  const map = new Map<string, string>();
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      if (k) map.set(k, v);
    }
  }
  return {
    get(name: string) {
      const v = map.get(name);
      return v !== undefined ? { value: v } : undefined;
    },
  };
}

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
  const hostname = process.env.HOSTNAME || "0.0.0.0";
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
    const parsed = parseUrl(req.url || "", true);
    void handle(req, res, parsed);
  });

  server.on("upgrade", (req, socket, head) => {
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

    const internalFromQuery =
      typeof q.internalToken === "string"
        ? q.internalToken
        : Array.isArray(q.internalToken)
          ? q.internalToken[0]
          : undefined;

    let session = verifyRequestAuthOrInternal({
      cookies: cookiesFromHeader(req.headers.cookie),
      headers: {
        get(name: string) {
          if (name.toLowerCase() === INTERNAL_TOKEN_HEADER.toLowerCase()) {
            const h = headerGet(req, INTERNAL_TOKEN_HEADER);
            if (h) return h;
            return internalFromQuery ?? null;
          }
          return headerGet(req, name);
        },
      },
    });
    if (!session) {
      const rawTicket =
        typeof q.ticket === "string"
          ? q.ticket
          : Array.isArray(q.ticket)
            ? q.ticket[0]
            : undefined;
      const consumed = consumePtyWsTicket(rawTicket);
      if (consumed.ok) {
        session = { sub: consumed.sub, exp: Number.MAX_SAFE_INTEGER };
      }
    }
    if (!session) {
      rejectUpgrade(
        socket,
        401,
        "Unauthorized",
        `no session or ticket (cookie header ${req.headers.cookie ? "present" : "missing"}; use same host as login, e.g. localhost vs 127.0.0.1, or POST /api/apps/pty-ws-ticket then pass ?ticket= on the WS URL)`,
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
