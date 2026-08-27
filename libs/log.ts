
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

export function logError(scope: string, msg: string, err?: unknown, meta?: Meta): void {
  emit("error", scope, msg, meta, err);
}
