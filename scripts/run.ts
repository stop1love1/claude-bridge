/**
 * Cross-platform env-file loader + spawn wrapper.
 *
 *   bun scripts/run.ts <mode> <command> [...args]
 *
 * Loads `.env` → `.env.<mode>` → `.env.local` (later overrides
 * earlier — matches Next.js's own precedence), forces
 * `NODE_ENV=<mode>`, then exec's the command.
 *
 * Why this exists: `next start` parses `--port` and reads
 * `process.env.PORT` BEFORE Next loads `.env.*`, so a `PORT=…` line in
 * `.env.production` doesn't actually change the listening port unless
 * something pre-populates `process.env.PORT` first. On Windows MINGW
 * + Bun, the shell-pipeline used by `next build && next start` also
 * has historically dropped env vars between siblings. This wrapper
 * solves both: env vars are guaranteed to be in the spawned child's
 * process.env, and the entrypoint is the same on every OS.
 *
 * Trade-off: we re-implement a small env-file parser instead of
 * pulling in `dotenv` / `dotenv-cli`. Worth it to keep `package.json`
 * dep-free and not regress what we already removed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [, , modeArg, ...rest] = process.argv;
const mode = modeArg === "development" ? "development" : modeArg === "production" ? "production" : null;
if (!mode || rest.length === 0) {
  console.error(
    "usage: bun scripts/run.ts <development|production> <command> [...args]",
  );
  process.exit(1);
}

/**
 * Minimal `.env` parser — handles `KEY=value`, `KEY="quoted value"`,
 * `KEY='single'`, blank lines, and `#` comments. Skips lines without
 * `=`. Doesn't expand variable references (`$FOO`) — keep it simple.
 *
 * Earlier-loaded values are overwritten by later loads, matching the
 * Next.js precedence chain. We DO let later files override even when
 * the variable already exists in `process.env`, since the user's
 * intent here is "per-mode env file controls runtime config" — a stale
 * shell var would otherwise silently win.
 */
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv(".env");
loadEnv(`.env.${mode}`);
loadEnv(".env.local");
loadEnv(`.env.${mode}.local`);
// `process.env.NODE_ENV` is typed as the readonly `"development" |
// "production" | "test"` literal union by Next.js's type augmentation.
// Direct assignment fails `tsc --strict`; cast through a bracket
// access to keep the runtime semantics identical.
(process.env as Record<string, string>)["NODE_ENV"] = mode;

const [command, ...args] = rest;
const child = spawn(command, args, { stdio: "inherit", shell: true });
child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise the signal so Ctrl-C in the parent terminal continues
    // to behave correctly (otherwise we'd swallow SIGINT and the
    // shell would print "Terminate batch job (Y/N)?").
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
