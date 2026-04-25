#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * PreToolUse permission hook for the bridge UI.
 *
 * Wired in via per-session `--settings` JSON written by `lib/permissionSettings.ts`.
 * Claude invokes us before every tool call, with the PreToolUse payload on
 * stdin (see claude-code/plugins/plugin-dev/skills/hook-development):
 *
 *   { session_id, transcript_path, cwd, permission_mode,
 *     hook_event_name: "PreToolUse", tool_name, tool_input }
 *
 * We:
 *   1. POST the request to the bridge with a fresh requestId.
 *   2. Long-poll the bridge until the user clicks Allow / Deny in the UI.
 *   3. Print the matching `hookSpecificOutput.permissionDecision` JSON to
 *      stdout so claude honors it.
 *
 * Failure mode = fail-open. If the bridge is unreachable, the poll times
 * out, JSON parse fails, etc., we exit 0 with no output and let claude
 * proceed. Per the spec, the user has decided this is the safe default —
 * a non-running bridge UI must not block the running coordinator. We log
 * to stderr so the failure is at least visible in `claude --debug=hooks`.
 *
 * Pure CommonJS / Node built-ins. No deps — runs on whatever Node ships
 * with the user's claude install on Win/macOS/Linux.
 */

"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const BRIDGE_HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 7777);
const POLL_INTERVAL_MS = 500;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — matches hook timeout in settings.json (360s safety margin).

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
        },
        timeout: 5000,
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("post timeout")); });
    req.write(payload);
    req.end();
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        method: "GET",
        path,
        timeout: 5000,
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("get timeout")); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function failOpen(reason) {
  process.stderr.write(`[permission-hook] fail-open: ${reason}\n`);
  process.exit(0);
}

(async function main() {
  // By default the hook contacts the bridge so the user gets an
  // Allow/Deny popup for every tool call. The spawner explicitly opts
  // out by setting `BRIDGE_AUTO_APPROVE=1` — that path is wired only
  // for permission-mode `bypassPermissions` (coordinator + auto-spawned
  // children that have no TTY to prompt against). Empty stdout + exit
  // 0 == claude proceeds with the call.
  if (process.env.BRIDGE_AUTO_APPROVE === "1") {
    process.exit(0);
  }

  let payload = {};
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    return failOpen(`stdin parse error: ${(e && e.message) || e}`);
  }

  // Accept both snake_case (current docs) and camelCase (older builds).
  const sessionId = payload.session_id || payload.sessionId;
  const tool = payload.tool_name || payload.tool || "unknown";
  const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? {};

  if (!sessionId) {
    return failOpen("payload missing session_id");
  }

  const requestId = randomUUID();
  const sidEnc = encodeURIComponent(sessionId);
  const ridEnc = encodeURIComponent(requestId);

  // Step 1: announce the pending request.
  try {
    const r = await postJson(
      `/api/sessions/${sidEnc}/permission`,
      { requestId, tool, input, timestamp: new Date().toISOString() },
    );
    if (r.status >= 400) return failOpen(`announce failed: HTTP ${r.status}`);
  } catch (e) {
    return failOpen(`announce error: ${(e && e.message) || e}`);
  }

  // Step 2: long-poll for the user's decision.
  const startedAt = Date.now();
  while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
    try {
      const r = await getJson(`/api/sessions/${sidEnc}/permission/${ridEnc}`);
      if (r.status === 202) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (r.status === 200) {
        const parsed = JSON.parse(r.body || "{}");
        const decision = parsed.status || parsed.decision; // tolerate either shape
        const reason = parsed.reason || "User denied via bridge UI";
        if (decision === "allow") {
          // Empty stdout → claude proceeds with the tool call as-is.
          process.exit(0);
        }
        if (decision === "deny" || decision === "block") {
          // Modern PreToolUse output shape (see claude-code hook-development docs):
          //   { hookSpecificOutput: { permissionDecision: "deny" }, systemMessage: "..." }
          // claude treats `permissionDecision: "deny"` as a hard block on this tool call.
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: "deny",
            },
            systemMessage: reason,
          }));
          process.exit(0);
        }
        return failOpen(`unrecognized decision: ${JSON.stringify(parsed)}`);
      }
      // 404 / 5xx — bridge lost the request. Fail open.
      return failOpen(`poll failed: HTTP ${r.status}`);
    } catch (e) {
      return failOpen(`poll error: ${(e && e.message) || e}`);
    }
  }

  return failOpen(`timed out after ${TOTAL_TIMEOUT_MS}ms`);
})();
