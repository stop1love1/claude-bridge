import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Make a fresh temp directory under the system temp dir, prefixed
 * with `bridge-<label>-` so test failures show which suite created it.
 * Returns the absolute path. Caller is responsible for `rmSync` in
 * the test's afterEach.
 */
export function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-${label}-`));
}
