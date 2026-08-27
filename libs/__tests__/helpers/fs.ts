import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-${label}-`));
}
