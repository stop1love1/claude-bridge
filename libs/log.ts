/**
 * Tiny structured logger.
 *
 * The bridge had 175 `console.*` calls scattered across 39 files with
 * no consistent format and (in 17 places) error patterns like
 * `console.error("...", (err as Error).message)` that drop stack
 * traces — making post-incident debugging painful.
 *
 * This file introduces a uniform shape:
 *
 *   logInfo("verify",  "chain passed", { tag, taskId });
 *   logWarn("verify",  "chain failed", { tag, failedStep });
 *   logError("verify", "chain crashed", err, { tag });
 *
 * Output strategy:
 *   - Default (dev): `[bridge:verify] chain passed { tag: ... }` — same
 *     visual rhythm as the existing `[bridge] ...` startup banner, easy
 *     to grep via `[bridge:`.
 *   - `BRIDGE_JSON_LOGS=1` (or any truthy value): one JSON object per
 *     line with `{ ts, level, scope, msg, ...meta }` plus an `err`
 *     object on errors with `{ name, message, stack }`. Designed for
 *     `pm2`/`docker`-style log shippers that JSON-parse stdout.
 *
 * Migration is opt-in. Existing `console.*` calls keep working; new
 * code (and future migrations of the worst offenders) should reach for
 * these helpers. Errors should ALWAYS go through `logError` so stacks
 * survive: `(err as Error).message` is a footgun.
 *
 * No external deps — zero install cost, zero bundle impact on the
 * client (server-only file).
 */

type Meta = Record<string, unknown> | undefined;

const JSON_LOGS = (() => {
  const v = process.env.BRIDGE_JSON_LOGS;
  return v === "1" || v === "true";
})();

function emit(level: "info" | "warn" | "error", scope: string, msg: string, meta?: Meta, err?: unknown): void {
  if (JSON_LOGS) {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
    };
    if (meta) Object.assign(line, meta);
    if (err !== undefined) {
      if (err instanceof Error) {
        line.err = { name: err.name, message: err.message, stack: err.stack };
      } else {
        line.err = err;
      }
    }
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(JSON.stringify(line));
    return;
  }
  // Pretty mode: keep stack traces intact by passing the raw Error to
  // console.error — Node prints `Error: ... \n    at ...` for us.
  const tag = `[bridge:${scope}]`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  if (level === "error") {
    if (err !== undefined) console.error(`${tag} ${msg}${metaStr}`, err);
    else console.error(`${tag} ${msg}${metaStr}`);
  } else if (level === "warn") {
    console.warn(`${tag} ${msg}${metaStr}`);
  } else {
    console.log(`${tag} ${msg}${metaStr}`);
  }
}

export function logInfo(scope: string, msg: string, meta?: Meta): void {
  emit("info", scope, msg, meta);
}

export function logWarn(scope: string, msg: string, meta?: Meta): void {
  emit("warn", scope, msg, meta);
}

/**
 * Always pass the raw `err` (not `err.message`) so the stack survives.
 * `meta` carries the correlation context (taskId, sessionId, tag).
 */
export function logError(scope: string, msg: string, err?: unknown, meta?: Meta): void {
  emit("error", scope, msg, meta, err);
}
