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

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_BACKOFF_MS = [5, 15, 30];
const sleepSlot = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepSlot, 0, 0, ms);
}

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && RETRYABLE_RENAME_CODES.has(code);
}

function renameWithRetry(tmp: string, filePath: string): void {
  let firstError: unknown;
  for (
    let attempt = 0;
    attempt <= RENAME_RETRY_BACKOFF_MS.length;
    attempt += 1
  ) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (attempt === 0) firstError = err;
      if (!isRetryableRenameError(err)) throw err;
      if (attempt === RENAME_RETRY_BACKOFF_MS.length) throw firstError;
      sleepSync(RENAME_RETRY_BACKOFF_MS[attempt]);
    }
  }
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
    renameWithRetry(tmp, filePath);
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
