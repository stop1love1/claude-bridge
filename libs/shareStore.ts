
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";

const SHARES_FILE = join(BRIDGE_STATE_DIR, "shares.json");

export interface ShareGrants {
  sendMessage: boolean;
  spawnAgent: boolean;
  answerPermission: boolean;
  commit: boolean;
  push: boolean;
  approvePlan: boolean;
  viewPreview: boolean;
}

export interface ShareGit {
  branchMode: "current" | "fixed" | "auto-create";
  branchName?: string;
  autoCommit: boolean;
  autoPush: boolean;
}

export interface GuestDevice {
  did: string;
  label: string;
  ip: string;
  approvedAt: string;
  expiresAt: number | null;
}

export interface Share {
  id: string;
  tokenHash: string;
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

export function createShare(input: CreateShareInput): { share: Share; token: string } {
  load();
  const token = randomBytes(24).toString("base64url");
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

function normalizeGrants(g: ShareGrants): ShareGrants {
  const commit = !!g.commit || !!g.push;
  const spawnAgent = g.spawnAgent === undefined ? !!g.sendMessage : !!g.spawnAgent;
  const approvePlan = !!g.approvePlan;
  const viewPreview = !!g.viewPreview;
  return {
    sendMessage: !!g.sendMessage,
    spawnAgent,
    answerPermission: !!g.answerPermission,
    commit,
    push: !!g.push,
    approvePlan,
    viewPreview,
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

export function verifyShareToken(id: string, token: string): boolean {
  const share = getShare(id);
  if (!share || !token) return false;
  return constantTimeEqualHex(share.tokenHash, sha256Hex(token));
}

export function isShareUsable(share: Share, now: number = Date.now()): boolean {
  if (share.revoked) return false;
  if (share.expiresAt !== null && share.expiresAt <= now) return false;
  return true;
}

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

export function _resetForTests(): void {
  state.data = { shares: [] };
  state.loaded = true;
}

export const _internal = { SHARES_FILE, sha256Hex };
