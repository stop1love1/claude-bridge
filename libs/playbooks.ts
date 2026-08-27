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
