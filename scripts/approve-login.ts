/**
 * Approve / deny a pending device login from the terminal.
 *
 *   bun scripts/approve-login.ts <pendingId>            # approve
 *   bun scripts/approve-login.ts <pendingId> --deny     # deny
 *
 * Why this exists: the device-approval flow in `app/_components/
 * LoginApprovalDialog.tsx` only fires for browser tabs that already
 * have a valid session cookie. If you're between machines (lost the
 * trusted device, or simply not at it), this CLI lets you tap the
 * approve path from any terminal that can read the local
 * `~/.claude/bridge.json` — same security boundary as `set-password.ts`
 * and `telegram-login.ts`.
 *
 * The script reads `auth.internalToken` from bridge.json and posts to
 * `POST /api/auth/approvals/<id>` with `x-bridge-internal-token`. The
 * approvals route accepts that header as auth (`verifyRequestAuthOrInternal`).
 *
 * The bridge MUST be running (we hit its HTTP API). If you stopped it
 * before approving, the in-memory pending entry is gone — log in again
 * to get a fresh pendingId.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const denyMode = args.includes("--deny");
const positional = args.filter((a) => !a.startsWith("--"));
const pendingId = positional[0];

if (!pendingId) {
  console.error(
    [
      "usage: bun scripts/approve-login.ts <pendingId> [--deny]",
      "",
      "Approves (or denies) a device login that's waiting on the bridge's",
      "approval queue. Copy <pendingId> from the 'Waiting for approval'",
      "screen on the new device.",
    ].join("\n"),
  );
  process.exit(1);
}

const BRIDGE_JSON = join(homedir(), ".claude", "bridge.json");
if (!existsSync(BRIDGE_JSON)) {
  console.error(
    `✗ ~/.claude/bridge.json not found — run \`bun run set:password\` first.`,
  );
  process.exit(1);
}

let cfg: {
  auth?: { internalToken?: string };
  runtime?: { url?: string; port?: number };
};
try {
  cfg = JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as typeof cfg;
} catch (err) {
  console.error(`✗ failed to read bridge.json: ${(err as Error).message}`);
  process.exit(1);
}

const token = cfg.auth?.internalToken?.trim();
if (!token) {
  console.error(
    "✗ no internalToken in bridge.json. The bridge auto-creates one on" +
    " first auth setup; re-run `bun run set:password` to seed it.",
  );
  process.exit(1);
}

// Resolve the bridge's HTTP origin. Order:
//   1. BRIDGE_URL env (operator override / remote host)
//   2. bridge.json#runtime.url (live server writes this on startup —
//      lets the CLI find dev OR prod port without env juggling)
//   3. PORT / BRIDGE_PORT env (last-ditch — only useful when the
//      bridge hasn't booted yet)
//   4. localhost:7777 (the documented dev default)
const envOrigin = process.env.BRIDGE_URL?.trim();
const runtimeUrl = cfg.runtime?.url?.trim();
const fallbackPort =
  process.env.BRIDGE_PORT?.trim() ??
  process.env.PORT?.trim() ??
  String(cfg.runtime?.port ?? 7777);
const origin = envOrigin || runtimeUrl || `http://localhost:${fallbackPort}`;
const url = `${origin}/api/auth/approvals/${encodeURIComponent(pendingId)}`;
const decision = denyMode ? "denied" : "approved";

try {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-internal-token": token,
    },
    body: JSON.stringify({ decision }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`✗ ${r.status} ${text || r.statusText}`);
    process.exit(1);
  }
  console.log(
    `${denyMode ? "🛑 denied" : "✅ approved"} pending login \`${pendingId}\``,
  );
  if (text) console.log(text);
} catch (err) {
  console.error(
    `✗ request failed: ${(err as Error).message}`,
    `\n  is the bridge running at ${origin}?`,
  );
  process.exit(1);
}
