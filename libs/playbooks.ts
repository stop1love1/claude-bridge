/**
 * Playbook loader (Phase 1 / item H1 of the agentic-coder roadmap).
 *
 * A playbook is a markdown template the bridge prepends to a child's
 * `## Your role` section when the dispatched role has a matching file
 * under `prompts/playbooks/<role>.md`. Lets the team codify how a given
 * role (`reviewer`, `coder`, `style-critic`, …) should approach work
 * without forcing the coordinator to re-explain it in every spawn.
 *
 * Roles passed in here have already been validated by `isValidAgentRole`
 * (charset `[A-Za-z0-9._-]{1,64}`) at the API boundary, so the file
 * path can never traverse outside `BRIDGE_LOGIC_DIR/playbooks/`. We
 * still gate defensively here so the function is safe to call from
 * other entry points.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_LOGIC_DIR } from "./paths";
import { isValidAgentRole } from "./validate";

const PLAYBOOK_CAP_BYTES = 32 * 1024;
const PLAYBOOKS_DIR = join(BRIDGE_LOGIC_DIR, "playbooks");

export function playbookPath(role: string): string {
  return join(PLAYBOOKS_DIR, `${role}.md`);
}

export function loadPlaybook(role: string): string | null {
  if (!isValidAgentRole(role)) return null;
  const p = playbookPath(role);
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    return buf.subarray(0, PLAYBOOK_CAP_BYTES).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}
