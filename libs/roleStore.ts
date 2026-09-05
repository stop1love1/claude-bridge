import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";
import { isBuiltinRoleLabel } from "./roleDefs";
import { isValidAgentRole, isValidToolName } from "./validate";

/**
 * Operator-defined roles, stored as an overlay on top of the built-in
 * `ROLE_DEFS` table in `libs/roleRegistry.ts`.
 *
 * This module is deliberately dumb: it validates *shape* and persists JSON.
 * It never computes a deny-list — that is policy, and policy lives in the
 * registry so there is exactly one place where "what is this role allowed to
 * do" is decided. `disallowedTools` here is an **additive** list: the registry
 * merges it on top of the base deny-list for the role's mutating flag, so a
 * custom role can only ever be *more* restricted than the default.
 *
 * The file is absent on a fresh bridge; everything below degrades to "no
 * custom roles", which is what makes `listRoles()` identical to the built-in
 * table until an operator actually adds something.
 */

const ROLES_FILE = join(BRIDGE_STATE_DIR, "roles.json");

/** Same cap as `libs/playbooks.ts` uses for on-disk playbooks. */
const PLAYBOOK_CAP_BYTES = 32 * 1024;
const MAX_CUSTOM_ROLES = 100;
const MAX_EXTRA_DENIES = 32;
const DESCRIPTION_CAP = 240;

/**
 * Stricter than `isValidAgentRole` on purpose. `resolveRole()` lowercases the
 * label it is given and compares against role names, so an uppercase or
 * dotted name could never match anything; rejecting it at write time is
 * kinder than storing a role that silently never resolves.
 */
const CUSTOM_ROLE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface CustomRoleDef {
  name: string;
  /** Same meaning as the built-in table: false = read-only, skips the plan gate. */
  mutating: boolean;
  description: string;
  /** ADDITIVE denies, merged on top of the base deny-list. Never subtractive. */
  disallowedTools: string[];
  /** Markdown playbook body, or null to inherit nothing. */
  playbook: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleBundle {
  version: 1;
  kind: "bridge-roles";
  exportedAt: string;
  roles: CustomRoleDef[];
}

interface StoreShape {
  version: 1;
  roles: CustomRoleDef[];
}

interface StoreState {
  data: StoreShape;
  /** mtime+size of the file the cache was built from; null = file absent. */
  stamp: string | null;
  loaded: boolean;
}

const G = globalThis as unknown as { __bridgeRoleStore?: StoreState };
const state: StoreState =
  G.__bridgeRoleStore ??
  (G.__bridgeRoleStore = { data: { version: 1, roles: [] }, stamp: null, loaded: false });

function fileStamp(): string | null {
  try {
    const st = statSync(ROLES_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function load(): StoreShape {
  const stamp = fileStamp();
  if (state.loaded && state.stamp === stamp) return state.data;
  let roles: CustomRoleDef[] = [];
  try {
    if (existsSync(ROLES_FILE)) {
      const parsed = JSON.parse(readFileSync(ROLES_FILE, "utf8")) as unknown;
      roles = normalizeRoleList(parsed);
    }
  } catch {
    roles = [];
  }
  state.data = { version: 1, roles };
  state.stamp = stamp;
  state.loaded = true;
  return state.data;
}

function persist(): void {
  writeJsonAtomic(ROLES_FILE, state.data);
  state.stamp = fileStamp();
  state.loaded = true;
}

// ---------------------------------------------------------------------------
// Normalisation / validation
// ---------------------------------------------------------------------------

function normalizeName(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function normalizeDescription(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, DESCRIPTION_CAP) : "";
}

function normalizeDenies(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (!isValidToolName(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_EXTRA_DENIES) break;
  }
  return out;
}

function normalizePlaybook(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const body = Buffer.from(v, "utf8")
    .subarray(0, PLAYBOOK_CAP_BYTES)
    .toString("utf8")
    .trim();
  return body || null;
}

function normalizeStamp(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/**
 * Accept a whole stored/imported list, dropping entries that cannot be trusted
 * rather than throwing: a hand-mangled `roles.json` must degrade to "fewer
 * custom roles", never to a bridge that will not boot.
 */
function normalizeRoleList(parsed: unknown): CustomRoleDef[] {
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { roles?: unknown } | null)?.roles)
      ? ((parsed as { roles: unknown[] }).roles)
      : [];
  const out: CustomRoleDef[] = [];
  const now = new Date().toISOString();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = normalizeName(e.name);
    if (!isAssignableCustomName(name)) continue;
    if (out.some((r) => r.name === name)) continue;
    out.push({
      name,
      mutating: e.mutating === true,
      description: normalizeDescription(e.description),
      disallowedTools: normalizeDenies(e.disallowedTools),
      playbook: normalizePlaybook(e.playbook),
      createdAt: normalizeStamp(e.createdAt, now),
      updatedAt: normalizeStamp(e.updatedAt, now),
    });
    if (out.length >= MAX_CUSTOM_ROLES) break;
  }
  return out;
}

/**
 * Names a custom role may take. Everything a built-in already owns is out of
 * bounds — including suffixed variants (`coder-api`), because those resolve to
 * a built-in by prefix and letting an operator redefine them would be a way to
 * quietly change an existing role's plan-gate classification.
 *
 * The registry resolves built-ins first regardless, so this check is the
 * friendly half of a belt-and-braces pair, not the only guard.
 */
export function isAssignableCustomName(name: string): boolean {
  if (!name || name.length > 64) return false;
  if (!CUSTOM_ROLE_NAME_RE.test(name)) return false;
  // Keeps the playbook path helpers safe even though custom playbooks never
  // touch the filesystem: one definition of "a role label" for the whole repo.
  if (!isValidAgentRole(name)) return false;
  if (isBuiltinRoleLabel(name)) return false;
  return true;
}

export interface RoleWriteInput {
  name: string;
  mutating: boolean;
  description?: string;
  /** Additive denies only; the registry merges the base deny-list on top. */
  disallowedTools?: string[];
  playbook?: string | null;
}

export type RoleWriteResult =
  | { ok: true; role: CustomRoleDef }
  | { ok: false; error: string; status: 400 | 404 | 409 };

function fail(error: string, status: 400 | 404 | 409 = 400): RoleWriteResult {
  return { ok: false, error, status };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listCustomRoles(): CustomRoleDef[] {
  return load().roles.map((r) => ({ ...r, disallowedTools: [...r.disallowedTools] }));
}

export function getCustomRole(name: string): CustomRoleDef | null {
  const n = normalizeName(name);
  const found = load().roles.find((r) => r.name === n);
  return found ? { ...found, disallowedTools: [...found.disallowedTools] } : null;
}

/**
 * Prefix-resolve a dispatch label against the custom overlay, longest base
 * first — the same rule the built-in table uses, so `security-auditor-api`
 * inherits `security-auditor`.
 *
 * Callers must check the built-in table first: a custom name can never resolve
 * to a built-in (see `isAssignableCustomName`), but resolution order is what
 * makes that guarantee hold even for a hand-edited `roles.json`.
 */
export function findCustomRole(label: string): CustomRoleDef | null {
  const r = normalizeName(label);
  if (!r) return null;
  let best: CustomRoleDef | null = null;
  for (const def of load().roles) {
    if (r === def.name || r.startsWith(def.name + "-")) {
      if (!best || def.name.length > best.name.length) best = def;
    }
  }
  return best ? { ...best, disallowedTools: [...best.disallowedTools] } : null;
}

/** The playbook body an operator wrote for a custom role, if any. */
export function loadCustomPlaybook(label: string): string | null {
  return findCustomRole(label)?.playbook ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function validateInput(input: RoleWriteInput): { error: string } | null {
  if (typeof input.name !== "string" || !input.name.trim()) {
    return { error: "name is required" };
  }
  if (typeof input.mutating !== "boolean") {
    return { error: "mutating must be a boolean" };
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    return { error: "description must be a string" };
  }
  if (input.disallowedTools !== undefined && !Array.isArray(input.disallowedTools)) {
    return { error: "disallowedTools must be an array of tool names" };
  }
  if (Array.isArray(input.disallowedTools)) {
    for (const t of input.disallowedTools) {
      if (!isValidToolName(t)) return { error: `invalid tool name: ${String(t)}` };
    }
  }
  if (
    input.playbook !== undefined &&
    input.playbook !== null &&
    typeof input.playbook !== "string"
  ) {
    return { error: "playbook must be a string or null" };
  }
  return null;
}

export function createCustomRole(input: RoleWriteInput): RoleWriteResult {
  const bad = validateInput(input);
  if (bad) return fail(bad.error);
  const name = normalizeName(input.name);
  if (!isAssignableCustomName(name)) {
    return fail(
      "name must be lowercase letters, digits and single dashes (e.g. security-auditor)",
    );
  }
  const data = load();
  if (data.roles.some((r) => r.name === name)) {
    return fail(`role "${name}" already exists`, 409);
  }
  if (data.roles.length >= MAX_CUSTOM_ROLES) {
    return fail(`too many custom roles (max ${MAX_CUSTOM_ROLES})`);
  }
  const now = new Date().toISOString();
  const role: CustomRoleDef = {
    name,
    mutating: input.mutating === true,
    description: normalizeDescription(input.description),
    disallowedTools: normalizeDenies(input.disallowedTools),
    playbook: normalizePlaybook(input.playbook),
    createdAt: now,
    updatedAt: now,
  };
  data.roles.push(role);
  persist();
  return { ok: true, role: { ...role, disallowedTools: [...role.disallowedTools] } };
}

export interface RolePatch {
  mutating?: boolean;
  description?: string;
  disallowedTools?: string[];
  playbook?: string | null;
}

export function updateCustomRole(name: string, patch: RolePatch): RoleWriteResult {
  const n = normalizeName(name);
  const data = load();
  const role = data.roles.find((r) => r.name === n);
  if (!role) return fail(`role "${n || String(name)}" not found`, 404);
  const merged: RoleWriteInput = {
    name: role.name,
    mutating: patch.mutating === undefined ? role.mutating : patch.mutating,
    description: patch.description === undefined ? role.description : patch.description,
    disallowedTools:
      patch.disallowedTools === undefined ? role.disallowedTools : patch.disallowedTools,
    playbook: patch.playbook === undefined ? role.playbook : patch.playbook,
  };
  const bad = validateInput(merged);
  if (bad) return fail(bad.error);
  role.mutating = merged.mutating;
  role.description = normalizeDescription(merged.description);
  role.disallowedTools = normalizeDenies(merged.disallowedTools);
  role.playbook = normalizePlaybook(merged.playbook);
  role.updatedAt = new Date().toISOString();
  persist();
  return { ok: true, role: { ...role, disallowedTools: [...role.disallowedTools] } };
}

export function deleteCustomRole(name: string): boolean {
  const n = normalizeName(name);
  const data = load();
  const before = data.roles.length;
  data.roles = data.roles.filter((r) => r.name !== n);
  if (data.roles.length === before) return false;
  state.data = data;
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Packaging — export / import the whole overlay as one JSON file
// ---------------------------------------------------------------------------

export function exportRoleBundle(): RoleBundle {
  return {
    version: 1,
    kind: "bridge-roles",
    exportedAt: new Date().toISOString(),
    roles: listCustomRoles(),
  };
}

export interface ImportResult {
  imported: number;
  replaced: number;
  skipped: number;
  roles: CustomRoleDef[];
}

/**
 * Import a bundle produced by `exportRoleBundle()` (the envelope is optional —
 * a bare `{ roles: [...] }` or a bare array works too).
 *
 * `merge` upserts by name and keeps roles the bundle does not mention;
 * `replace` makes the overlay exactly the bundle. Entries that fail validation
 * are counted in `skipped` rather than failing the whole import, so one bad
 * hand-edited role cannot block restoring the other twenty.
 */
export function importRoleBundle(
  bundle: unknown,
  mode: "merge" | "replace" = "merge",
): ImportResult {
  const incomingRaw = Array.isArray(bundle)
    ? bundle
    : Array.isArray((bundle as { roles?: unknown } | null)?.roles)
      ? (bundle as { roles: unknown[] }).roles
      : [];
  const incoming = normalizeRoleList(incomingRaw);
  const skipped = incomingRaw.length - incoming.length;
  const data = load();

  if (mode === "replace") {
    data.roles = incoming;
    persist();
    return { imported: incoming.length, replaced: 0, skipped, roles: listCustomRoles() };
  }

  let imported = 0;
  let replaced = 0;
  for (const role of incoming) {
    const idx = data.roles.findIndex((r) => r.name === role.name);
    if (idx >= 0) {
      data.roles[idx] = role;
      replaced += 1;
    } else {
      if (data.roles.length >= MAX_CUSTOM_ROLES) break;
      data.roles.push(role);
      imported += 1;
    }
  }
  persist();
  return { imported, replaced, skipped, roles: listCustomRoles() };
}

export function _resetForTests(): void {
  state.data = { version: 1, roles: [] };
  state.stamp = null;
  state.loaded = false;
}

export const _internal = { ROLES_FILE, MAX_CUSTOM_ROLES, PLAYBOOK_CAP_BYTES };
