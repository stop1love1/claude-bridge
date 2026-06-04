/**
 * Persistent store for task **share links**.
 *
 * A share grants login-less, operator-approved access to ONE task. The
 * link carries a high-entropy `token`; the store keeps only its SHA-256
 * hash, so a leaked `shares.json` can't be replayed as a working link.
 * Authorization for a guest request is always read FRESH from here
 * (revoked / expired / device-valid) — the guest cookie proves identity
 * only, never capability. See `docs/superpowers/specs/2026-05-30-task-
 * share-links-design.md`.
 *
 * Backed by `.bridge-state/shares.json`. The bridge is single-process
 * (enforced by `libs/processLock.ts`), so we hold an authoritative
 * in-memory copy on `globalThis` and write through on every mutation —
 * no per-request disk read in the proxy hot path. HMR-safe via the same
 * globalThis stash the other stores use.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";

const SHARES_FILE = join(BRIDGE_STATE_DIR, "shares.json");

export interface ShareGrants {
  /** Send prompts / drive existing runs (message, upload, kill). */
  sendMessage: boolean;
  /** Spawn NEW agent processes against the task (POST /tasks/:id/agents).
   *  Separate from `sendMessage` so "let them chat" doesn't silently also
   *  mean "let them launch unbounded subprocesses". */
  spawnAgent: boolean;
  /** Answer Allow/Deny permission popups for risky tools. */
  answerPermission: boolean;
  /** Commit the working tree. */
  commit: boolean;
  /** Push commits (implies `commit`). */
  push: boolean;
  /** Approve a task's intake plan so coding may proceed (Intent & Planning Gate). */
  approvePlan: boolean;
}

export interface ShareGit {
  branchMode: "current" | "fixed" | "auto-create";
  /** Branch name for `fixed` mode. */
  branchName?: string;
  autoCommit: boolean;
  autoPush: boolean;
}

export interface GuestDevice {
  /** "gdv_<hex>" — also embedded in the guest cookie. */
  did: string;
  /** Display name the guest entered, or a UA-derived fallback. */
  label: string;
  ip: string;
  approvedAt: string;
  /** approvedAt + share.deviceTtlMs, or null for "remember forever". */
  expiresAt: number | null;
}

export interface Share {
  id: string;
  /** sha256(token) hex — the raw token is shown once, never stored. */
  tokenHash: string;
  taskId: string;
  label?: string;
  grants: ShareGrants;
  git: ShareGit;
  /** Per-device approval lifetime; null = until revoked. */
  deviceTtlMs: number | null;
  /** Share-level hard expiry (epoch ms); null = no expiry. */
  expiresAt: number | null;
  revoked: boolean;
  createdAt: string;
  devices: GuestDevice[];
}

interface StoreShape {
  shares: Share[];
}

interface StoreState {
  data: StoreShape;
  loaded: boolean;
}

const G = globalThis as unknown as { __bridgeShareStore?: StoreState };
const state: StoreState =
  G.__bridgeShareStore ?? (G.__bridgeShareStore = { data: { shares: [] }, loaded: false });

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(SHARES_FILE)) {
      const raw = readFileSync(SHARES_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      state.data = { shares: Array.isArray(parsed.shares) ? parsed.shares : [] };
    }
  } catch {
    // Corrupt file → start clean rather than crashing the bridge. The
    // next mutation rewrites it.
    state.data = { shares: [] };
  }
  state.loaded = true;
}

function persist(): void {
  writeJsonAtomic(SHARES_FILE, state.data);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  // Equal-length hex strings → safe to timing-compare as buffers.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

export interface CreateShareInput {
  taskId: string;
  grants: ShareGrants;
  git: ShareGit;
  deviceTtlMs?: number | null;
  expiresAt?: number | null;
  label?: string;
}

/**
 * Create a share. Returns the persisted record AND the raw token (shown
 * to the operator exactly once — it's never recoverable from the store).
 */
export function createShare(input: CreateShareInput): { share: Share; token: string } {
  load();
  const token = randomBytes(24).toString("base64url"); // 192-bit
  const share: Share = {
    id: genId("shr"),
    tokenHash: sha256Hex(token),
    taskId: input.taskId,
    label: input.label?.trim() ? input.label.trim().slice(0, 120) : undefined,
    grants: normalizeGrants(input.grants),
    git: normalizeGit(input.git),
    deviceTtlMs: input.deviceTtlMs ?? null,
    expiresAt: input.expiresAt ?? null,
    revoked: false,
    createdAt: new Date().toISOString(),
    devices: [],
  };
  state.data.shares.push(share);
  persist();
  return { share, token };
}

/** Push implies commit; keep the flags internally consistent. */
function normalizeGrants(g: ShareGrants): ShareGrants {
  const commit = !!g.commit || !!g.push;
  // Back-compat: shares persisted before `spawnAgent` existed (and API
  // callers that omit it) inherit `sendMessage`, preserving the old
  // behavior where sending also allowed spawning. Callers that pass the
  // field explicitly (the UI) get independent control.
  const spawnAgent = g.spawnAgent === undefined ? !!g.sendMessage : !!g.spawnAgent;
  // Intent & Planning Gate: default false for shares created before this
  // grant existed (and callers that omit it) — a guest can't approve plans
  // unless the operator explicitly grants it.
  const approvePlan = !!g.approvePlan;
  return {
    sendMessage: !!g.sendMessage,
    spawnAgent,
    answerPermission: !!g.answerPermission,
    commit,
    push: !!g.push,
    approvePlan,
  };
}

function normalizeGit(git: ShareGit): ShareGit {
  const branchMode =
    git.branchMode === "fixed" || git.branchMode === "auto-create"
      ? git.branchMode
      : "current";
  return {
    branchMode,
    branchName:
      branchMode === "fixed" && git.branchName?.trim()
        ? git.branchName.trim().slice(0, 200)
        : undefined,
    autoCommit: !!git.autoCommit,
    autoPush: !!git.autoPush,
  };
}

export function listShares(taskId?: string): Share[] {
  load();
  const all = state.data.shares;
  return taskId ? all.filter((s) => s.taskId === taskId) : all.slice();
}

export function getShare(id: string): Share | null {
  load();
  return state.data.shares.find((s) => s.id === id) ?? null;
}

/** Constant-time verify a raw token against a share's stored hash. */
export function verifyShareToken(id: string, token: string): boolean {
  const share = getShare(id);
  if (!share || !token) return false;
  return constantTimeEqualHex(share.tokenHash, sha256Hex(token));
}

/** A share is usable when it isn't revoked and hasn't hit its hard expiry. */
export function isShareUsable(share: Share, now: number = Date.now()): boolean {
  if (share.revoked) return false;
  if (share.expiresAt !== null && share.expiresAt <= now) return false;
  return true;
}

/** Return a still-valid approved device, or null (missing / expired). */
export function findValidDevice(
  share: Share,
  did: string,
  now: number = Date.now(),
): GuestDevice | null {
  const dev = share.devices.find((d) => d.did === did);
  if (!dev) return null;
  if (dev.expiresAt !== null && dev.expiresAt <= now) return null;
  return dev;
}

export interface UpdateSharePatch {
  grants?: Partial<ShareGrants>;
  git?: Partial<ShareGit>;
  deviceTtlMs?: number | null;
  expiresAt?: number | null;
  label?: string;
  revoked?: boolean;
}

export function updateShare(id: string, patch: UpdateSharePatch): Share | null {
  load();
  const share = state.data.shares.find((s) => s.id === id);
  if (!share) return null;
  if (patch.grants) share.grants = normalizeGrants({ ...share.grants, ...patch.grants });
  if (patch.git) share.git = normalizeGit({ ...share.git, ...patch.git });
  if (patch.deviceTtlMs !== undefined) share.deviceTtlMs = patch.deviceTtlMs;
  if (patch.expiresAt !== undefined) share.expiresAt = patch.expiresAt;
  if (patch.label !== undefined) {
    share.label = patch.label.trim() ? patch.label.trim().slice(0, 120) : undefined;
  }
  if (patch.revoked !== undefined) share.revoked = patch.revoked;
  persist();
  return share;
}

export function revokeShare(id: string): boolean {
  return !!updateShare(id, { revoked: true });
}

export function deleteShare(id: string): boolean {
  load();
  const before = state.data.shares.length;
  state.data.shares = state.data.shares.filter((s) => s.id !== id);
  if (state.data.shares.length === before) return false;
  persist();
  return true;
}

/**
 * Register an approved device on a share (or refresh an existing one's
 * label/ip/expiry). Returns the device record.
 */
export function addDevice(
  id: string,
  input: { did: string; label: string; ip: string },
): GuestDevice | null {
  load();
  const share = state.data.shares.find((s) => s.id === id);
  if (!share) return null;
  const now = Date.now();
  const expiresAt = share.deviceTtlMs === null ? null : now + share.deviceTtlMs;
  const device: GuestDevice = {
    did: input.did,
    label: input.label.slice(0, 80),
    ip: input.ip,
    approvedAt: new Date(now).toISOString(),
    expiresAt,
  };
  const existing = share.devices.findIndex((d) => d.did === input.did);
  if (existing >= 0) share.devices[existing] = device;
  else share.devices.push(device);
  persist();
  return device;
}

/** Revoke a single approved device. */
export function revokeDevice(id: string, did: string): boolean {
  load();
  const share = state.data.shares.find((s) => s.id === id);
  if (!share) return false;
  const before = share.devices.length;
  share.devices = share.devices.filter((d) => d.did !== did);
  if (share.devices.length === before) return false;
  persist();
  return true;
}

/**
 * UI-safe projection of a share: everything the operator dashboard needs,
 * minus the secret `tokenHash`. The raw token is returned separately by
 * `createShare` (once); the link can't be reconstructed from this view.
 */
export interface ShareView {
  id: string;
  taskId: string;
  label?: string;
  grants: ShareGrants;
  git: ShareGit;
  deviceTtlMs: number | null;
  expiresAt: number | null;
  revoked: boolean;
  createdAt: string;
  devices: GuestDevice[];
}

export function toShareView(share: Share): ShareView {
  const { tokenHash: _omit, ...rest } = share;
  void _omit;
  return rest;
}

/** Test-only: reset the in-memory store so a suite starts clean. */
export function _resetForTests(): void {
  state.data = { shares: [] };
  state.loaded = true;
}

export const _internal = { SHARES_FILE, sha256Hex };
