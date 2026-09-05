import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_LOGIC_DIR } from "./paths";

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

const READ_ONLY_DENY = ["Edit", "MultiEdit", "NotebookEdit", "Task"];
const MUTATING_DENY = ["Task"];

interface RoleDef {
  name: string;
  mutating: boolean;
  orchestrator?: boolean;
  description: string;
}

const ROLE_DEFS: RoleDef[] = [
  {
    // Kept `mutating: true` on purpose: the coordinator writes summary.md and
    // is the role the plan gate is allowed to kick planning from, exactly as
    // before this entry existed (it used to fall through to defaultRoleSpec).
    name: "coordinator",
    mutating: true,
    orchestrator: true,
    description: "Bridge-reserved: orchestrates one task, dispatches children, edits no app tree.",
  },
  {
    name: "coder",
    mutating: true,
    description: "Implements a feature or change end-to-end in one repo.",
  },
  {
    name: "fixer",
    mutating: true,
    description: "Fixes a specific bug or a finding from a reviewer/tester.",
  },
  {
    name: "api-builder",
    mutating: true,
    description: "Builds the backend half of a cross-repo feature.",
  },
  {
    name: "ui-builder",
    mutating: true,
    description: "Builds the frontend half of a cross-repo feature.",
  },
  {
    name: "writer",
    mutating: true,
    description: "Produces docs or prose deliverables inside the repo.",
  },
  {
    name: "planner",
    mutating: false,
    description: "Drafts plan.md and intake.json; never edits source.",
  },
  {
    name: "reviewer",
    mutating: false,
    description: "Reviews a diff or module and reports findings with file:line.",
  },
  {
    name: "researcher",
    mutating: false,
    description: "Read-only research or audit; answers a question about the code.",
  },
  {
    name: "surveyor",
    mutating: false,
    description: "Maps an area before a refactor; hands findings to a coder.",
  },
  {
    name: "ui-tester",
    mutating: false,
    description: "Drives the rendered UI (Playwright MCP) and reports bugs.",
  },
  {
    name: "semantic-verifier",
    mutating: false,
    description: "Post-run gate: checks the change matches the task intent.",
  },
  {
    name: "style-critic",
    mutating: false,
    description: "Post-run gate: checks the diff against the house style.",
  },
  {
    name: "memory-distill",
    mutating: false,
    description: "Post-run: distills durable lessons into the app memory.",
  },
  {
    name: "devops",
    mutating: false,
    description: "Bridge-reserved: opens the PR when integrationMode is pull-request.",
  },
];

// Same convention as `libs/playbooks.ts` (`prompts/playbooks/<role>.md`), spelled
// out here so the registry stays a leaf module: planGate imports it, and tests
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

export function listRoles(): RoleSpec[] {
  return ROLE_DEFS.map(specFor);
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
 */
export function resolveRole(role: string): RoleSpec {
  const r = role.trim().toLowerCase();
  let best: RoleDef | null = null;
  for (const def of ROLE_DEFS) {
    if (r === def.name || r.startsWith(def.name + "-")) {
      if (!best || def.name.length > best.name.length) best = def;
    }
  }
  return best ? specFor(best) : defaultRoleSpec(role);
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
