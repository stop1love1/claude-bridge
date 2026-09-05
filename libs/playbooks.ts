import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_LOGIC_DIR } from "./paths";
import { loadCustomPlaybook } from "./roleStore";
import { isValidAgentRole } from "./validate";

const PLAYBOOK_CAP_BYTES = 32 * 1024;
const PLAYBOOKS_DIR = join(BRIDGE_LOGIC_DIR, "playbooks");

export function playbookPath(role: string): string {
  return join(PLAYBOOKS_DIR, `${role}.md`);
}

/**
 * A role's playbook: the file under `prompts/playbooks/` if one exists, else
 * the body an operator wrote for a custom role in `.bridge-state/roles.json`.
 *
 * The file branch is unchanged — a role that had a playbook file before the
 * overlay existed still reads exactly that file. Only the "no file" case,
 * which used to return null unconditionally, now consults the overlay; with no
 * custom roles that is still null.
 */
export function loadPlaybook(role: string): string | null {
  if (!isValidAgentRole(role)) return null;
  const p = playbookPath(role);
  if (!existsSync(p)) return loadCustomPlaybook(role);
  try {
    const buf = readFileSync(p);
    return buf.subarray(0, PLAYBOOK_CAP_BYTES).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}
