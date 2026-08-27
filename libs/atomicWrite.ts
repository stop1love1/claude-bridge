import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
}

function uniqueTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
}

export function writeStringAtomic(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = uniqueTmpPath(filePath);
  const writeOpts =
    opts?.mode !== undefined ? { mode: opts.mode } : undefined;
  writeFileSync(tmp, content, writeOpts);
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { }
    throw err;
  }
  if (opts?.mode !== undefined && process.platform !== "win32") {
    try { chmodSync(filePath, opts.mode); } catch { }
  }
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: AtomicWriteOptions,
): void {
  writeStringAtomic(filePath, JSON.stringify(value, null, 2) + "\n", opts);
}
