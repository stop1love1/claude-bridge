import { createServer, type IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import type { Duplex } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import next from "next";
import pty, { type IPty } from "node-pty";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DEMO_MODE } from "../libs/demoMode";
import { resolveBridgePort } from "../libs/paths";
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
      }
      return;
    }
    if (msg.t === "resize" && typeof msg.c === "number" && typeof msg.r === "number") {
      cols = Math.max(2, Math.min(512, Math.floor(msg.c)));
      rows = Math.max(1, Math.min(256, Math.floor(msg.r)));
      try {
        child.resize(cols, rows);
      } catch {
      }
    }
  });

  ws.on("close", () => {
    try {
      child.kill();
    } catch {
    }
  });
}

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const hostname =
    process.env.BRIDGE_HOST?.trim() ||
    process.env.HOST?.trim() ||
    "0.0.0.0";
  const port = resolveBridgePort(process.env);

  const app = next({ dev, hostname, port, dir: process.cwd() });
  const handle = app.getRequestHandler();
  await app.prepare();
  const nextUpgrade = app.getUpgradeHandler();

  const ptyWss = new WebSocketServer({ noServer: true });

  process.env.BRIDGE_PTY_READY = "1";

  const server = createServer((req, res) => {
    stampServerAuthoredHeaders(req);
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
