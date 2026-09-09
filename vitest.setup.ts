import { afterEach, beforeEach } from "vitest";

/**
 * Restores `process.cwd()` around every test.
 *
 * Vitest reuses a worker process across test files, and two files
 * (`telegramCommands`, `coordinatorNudge`) call `process.chdir()`. Both restore
 * it themselves, but `libs/paths.ts` freezes
 * `BRIDGE_ROOT = resolve(process.cwd())` at module load, so a throw between the
 * chdir and the restore — or a future file that forgets — leaves every module
 * loaded afterwards in that worker computing paths from a temp directory. That
 * is the shape of the gate failure this session spent a whole round chasing:
 * `childPrompt > falls back to runtime BRIDGE_ROOT when bridgeRoot is omitted`.
 *
 * Deliberately generic rather than a list of today's offenders: a new
 * `process.chdir()` anywhere is covered with nothing to remember.
 *
 * NOT done here: wiping `globalThis.__bridge*` before each file. It was tried
 * and measurably changed nothing — identical failures on all three shuffle
 * seeds — because the leaks are *within* a file, not across files. It also
 * actively breaks `waitRoute`, whose route reaches meta through
 * `@/libs/meta` while the test uses `../meta`; `globalThis.__bridgeMetaEvents`
 * is precisely the bridge that keeps those two specifiers on one event
 * emitter, so deleting it stops the route ever seeing the test's `updateRun`.
 */
const ORIGINAL_CWD = process.cwd();

function restoreCwd(): void {
  if (process.cwd() !== ORIGINAL_CWD) process.chdir(ORIGINAL_CWD);
}

beforeEach(restoreCwd);
afterEach(restoreCwd);
