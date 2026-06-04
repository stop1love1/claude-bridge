/**
 * Multi-coder Presence (Epic D) — ephemeral, TTL-based presence of the
 * participants (operator + guests) currently on a task. In-memory only
 * (lost on restart, which is correct for presence). Same globalThis +
 * Date.now() pattern as libs/heartbeat.ts.
 * See docs/superpowers/specs/2026-06-04-multi-coder-presence-design.md.
 */

export type ParticipantKind = "operator" | "guest";

export interface Participant {
  /** Stable identity: "operator" for the operator, the guest device `did` otherwise. */
  id: string;
  label: string;
  kind: ParticipantKind;
  lastSeen: number;
}

/** A participant is "present" if seen within this window. */
export const PRESENCE_TTL_MS = 20_000;

type TaskPresence = Map<string, Participant>;
interface Store {
  byTask: Map<string, TaskPresence>;
}
const G = globalThis as unknown as { __bridgePresenceStore?: Store };
const store: Store = G.__bridgePresenceStore ?? (G.__bridgePresenceStore = { byTask: new Map() });

/**
 * Cap a display label to a safe length + strip control characters
 * (code points < 32 and DEL). Char-code filter avoids a control-char
 * regex literal in the source.
 */
function sanitizeLabel(label: string): string {
  let out = "";
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.trim().slice(0, 40) || "(anonymous)";
}

/** Upsert a participant on a task and stamp `lastSeen = now`. */
export function touchPresence(
  taskId: string,
  p: { id: string; label: string; kind: ParticipantKind },
  now: number = Date.now(),
): void {
  let tp = store.byTask.get(taskId);
  if (!tp) {
    tp = new Map();
    store.byTask.set(taskId, tp);
  }
  tp.set(p.id, { id: p.id, label: sanitizeLabel(p.label), kind: p.kind, lastSeen: now });
}

/**
 * Active participants on a task (seen within the TTL), sorted operator-first
 * then by label. Sweeps stale entries as a side effect.
 */
export function listActive(taskId: string, now: number = Date.now()): Participant[] {
  const tp = store.byTask.get(taskId);
  if (!tp) return [];
  const cutoff = now - PRESENCE_TTL_MS;
  for (const [id, p] of tp) {
    if (p.lastSeen < cutoff) tp.delete(id);
  }
  if (tp.size === 0) {
    store.byTask.delete(taskId);
    return [];
  }
  return [...tp.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "operator" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** Test-only: wipe all presence. */
export function _clearForTests(): void {
  store.byTask.clear();
}
