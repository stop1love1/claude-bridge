import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_LOGIC_DIR } from "./paths";
import {
  matchLongest,
  MUTATING_DENY,
  READ_ONLY_DENY,
  ROLE_DEFS,
  type RoleDef,
} from "./roleDefs";
import { findCustomRole, listCustomRoles, type CustomRoleDef } from "./roleStore";

/**
 * Single source of truth for what a child role is allowed to do.
 *
 * `planGate.isMutatingRole` and the `/agents` dispatch route both read this
 * table, so a role's plan-gate classification and its CLI tool-restriction
 * can never drift apart. Roles resolve by prefix (`reviewer-api` → `reviewer`)
 * exactly like the old hardcoded list in planGate did; an unknown role falls
 * back to the mutating default with only `Task` denied.
 *
 * This is a guardrail, not a sandbox: Bash and Write stay open for every role
 * because reports, curl self-registration, and plan.md need them.
 */
export interface RoleSpec {
  name: string;
  mutating: boolean;
  /**
   * The role drives *other* agents instead of a repo's working tree: it runs
   * from BRIDGE_ROOT, spawns children, and reads/writes only session artifacts.
   * Call sites that hand out the one-run-per-repo reservation skip these roles
   * — an orchestrator that held its own repo's reservation would lock its own
   * children out of it (the self-target deadlock).
   */
  orchestrator: boolean;
  disallowedTools: string[];
  playbook: string | null;
  description: string;
}

// Same convention as `libs/playbooks.ts` (`prompts/playbooks/<role>.md`), spelled
// out here rather than imported from it: planGate imports this module, and tests
// that stub `../playbooks` must not be able to break role resolution.
function hasPlaybook(role: string): boolean {
  return existsSync(join(BRIDGE_LOGIC_DIR, "playbooks", `${role}.md`));
}

function specFor(def: RoleDef): RoleSpec {
  return {
    name: def.name,
    mutating: def.mutating,
    orchestrator: def.orchestrator === true,
    disallowedTools: def.mutating ? [...MUTATING_DENY] : [...READ_ONLY_DENY],
    playbook: hasPlaybook(def.name) ? def.name : null,
    description: def.description,
  };
}

/**
 * Turn an operator-defined role into a spec.
 *
 * Two things are deliberately not readable from the stored definition:
 *
 *  - `orchestrator` is always false. An orchestrator skips the one-run-per-repo
 *    reservation; that is a bridge-internal privilege, never something the UI
 *    hands out.
 *  - the deny-list is computed here, from `mutating`, and the stored list can
 *    only *add* to it. `mergeDisallowedTools` is the single exit, so a custom
 *    role's deny-list is a superset of the built-in one for its class — a
 *    role that declares itself read-only (and therefore skips the plan gate)
 *    always gets the read-only denies, whatever the payload asked for.
 */
function specForCustom(def: CustomRoleDef): RoleSpec {
  const base = def.mutating ? MUTATING_DENY : READ_ONLY_DENY;
  return {
    name: def.name,
    mutating: def.mutating,
    orchestrator: false,
    disallowedTools: mergeDisallowedTools(base, def.disallowedTools),
    playbook: def.playbook !== null || hasPlaybook(def.name) ? def.name : null,
    description: def.description,
  };
}

/**
 * The built-in table first, then any operator-defined roles from
 * `.bridge-state/roles.json`. With no overlay file this is exactly
 * `ROLE_DEFS.map(specFor)` — the pre-overlay behaviour.
 */
export function listRoles(): RoleSpec[] {
  return [...ROLE_DEFS.map(specFor), ...listCustomRoles().map(specForCustom)];
}

export function defaultRoleSpec(role: string): RoleSpec {
  return {
    name: role,
    mutating: true,
    orchestrator: false,
    disallowedTools: [...MUTATING_DENY],
    playbook: null,
    description: "Unregistered role; treated as mutating with only Task denied.",
  };
}

/**
 * Prefix-match a role label against the registry: `reviewer-api` and
 * `reviewer-2` both resolve to `reviewer`; `coder-phase24` resolves to
 * `coder`. Matching is case-insensitive and picks the longest base so that
 * `ui-tester` never collides with a hypothetical `ui` role.
 *
 * Built-ins are matched **before** the operator overlay, so a custom role can
 * never take over a label a built-in already owns. `roleStore` refuses to
 * store such a name in the first place; checking in this order means even a
 * hand-edited `roles.json` cannot loosen `planner` into a mutating role.
 */
export function resolveRole(role: string): RoleSpec {
  const r = role.trim().toLowerCase();
  const builtin = matchLongest(ROLE_DEFS, r);
  if (builtin) return specFor(builtin);
  const custom = findCustomRole(r);
  if (custom) return specForCustom(custom);
  return defaultRoleSpec(role);
}

/** Tool names to pass as `disallowedTools` when spawning or resuming `role`. */
export function disallowedToolsForRole(role: string): string[] {
  return resolveRole(role).disallowedTools;
}

/**
 * True when `role` orchestrates other agents rather than editing an app's
 * working tree. Resume paths (`/tasks/<id>/continue`, `/sessions/<id>/message`)
 * use this to decide whether the resumed session needs the repo reservation:
 * a coordinator does not, and taking it would block the children it is about
 * to dispatch into the same repo. Unknown roles are never orchestrators, so
 * the reservation is still taken when we cannot identify the run.
 */
export function isOrchestrationRole(role: string): boolean {
  return resolveRole(role).orchestrator;
}

/**
 * Merge the registry's deny-list with any deny-list the call site already
 * carries (e.g. `denyTaskToolNames()`), preserving order and dropping dupes.
 * Task is never removed from the result.
 */
export function mergeDisallowedTools(
  ...lists: Array<readonly string[] | undefined>
): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const t of list) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}
