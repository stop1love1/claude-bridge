/**
 * The built-in role table, extracted as a leaf module.
 *
 * `libs/roleRegistry.ts` turns these into `RoleSpec`s and `libs/roleStore.ts`
 * needs to know which names are already taken, so the table lives here rather
 * than in either of them — one source of truth, no import cycle.
 *
 * Nothing in here reads the filesystem or the operator overlay: this is the
 * table as it shipped, and it is what the registry falls back to when no
 * `.bridge-state/roles.json` exists.
 */

export const READ_ONLY_DENY = ["Edit", "MultiEdit", "NotebookEdit", "Task"];
export const MUTATING_DENY = ["Task"];

export interface RoleDef {
  name: string;
  mutating: boolean;
  orchestrator?: boolean;
  description: string;
}

export const ROLE_DEFS: RoleDef[] = [
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

/**
 * Longest-base prefix match, the rule the whole registry resolves by:
 * `reviewer-api` → `reviewer`, and `ui-tester` beats a hypothetical `ui`.
 * `label` must already be trimmed and lowercased.
 */
export function matchLongest<T extends { name: string }>(
  defs: readonly T[],
  label: string,
): T | null {
  let best: T | null = null;
  for (const def of defs) {
    if (label === def.name || label.startsWith(def.name + "-")) {
      if (!best || def.name.length > best.name.length) best = def;
    }
  }
  return best;
}

/**
 * True when a label already belongs to a built-in role — either its exact name
 * or a suffixed variant that resolves to it. Custom roles may not take these
 * names: redefining `coder-api` would quietly change the plan-gate
 * classification of a label operators already dispatch under.
 */
export function isBuiltinRoleLabel(label: string): boolean {
  return matchLongest(ROLE_DEFS, label.trim().toLowerCase()) !== null;
}
