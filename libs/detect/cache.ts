import { createHash } from "node:crypto";
import { readMeta, withTaskLock, writeMeta, type Meta } from "../meta";
import type { DetectedScope, DetectedScopeCacheEntry } from "./types";

export type { DetectedScopeCacheEntry };

export function hashTaskBody(body: string): string {
  return createHash("sha1").update(body ?? "", "utf8").digest("hex").slice(0, 16);
}

export function readScopeCache(
  sessionsDir: string,
): DetectedScope | null {
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const entry = meta.detectedScope;
  if (!entry) return null;
  if (entry.taskBodyHash !== hashTaskBody(meta.taskBody)) return null;
  return entry.scope;
}

export async function writeScopeCache(
  sessionsDir: string,
  scope: DetectedScope,
): Promise<void> {
  await withTaskLock(sessionsDir, () => {
    const meta = readMeta(sessionsDir);
    if (!meta) return;
    const next: Meta = {
      ...meta,
      detectedScope: {
        taskBodyHash: hashTaskBody(meta.taskBody),
        scope,
      },
    };
    writeMeta(sessionsDir, next);
  });
}

export async function clearScopeCache(sessionsDir: string): Promise<void> {
  await withTaskLock(sessionsDir, () => {
    const meta = readMeta(sessionsDir);
    if (!meta || !meta.detectedScope) return;
    const next: Meta = { ...meta };
    delete next.detectedScope;
    writeMeta(sessionsDir, next);
  });
}
