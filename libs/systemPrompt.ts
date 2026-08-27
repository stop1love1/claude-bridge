import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";

const SYS_PROMPT_CACHE_DIR = join(BRIDGE_STATE_DIR, "cache", "sys-prompts");

export function ensureSystemPromptFile(content: string): string | null {
  if (!content || content.length === 0) return null;
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const path = join(SYS_PROMPT_CACHE_DIR, `${hash}.txt`);
  if (!existsSync(path)) {
    mkdirSync(SYS_PROMPT_CACHE_DIR, { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return path;
}

export const ULTRACODE_DIRECTIVE = `<bridge-ultracode>
Ultracode mode is on for this session. Optimize for the most exhaustive, correct outcome — token cost is not a constraint. Do not trade correctness for speed or brevity.

- Decompose the work thoroughly and reason about edge cases before acting.
- Verify your own work: re-read what you changed, run the project's checks, and confirm behavior with evidence rather than asserting it.
- If you coordinate other agents, decompose aggressively and fan out independent work in parallel via the bridge's dispatch API (POST /api/tasks/<id>/agents) and its speculative variants — that is this environment's equivalent of multi-agent workflows. The in-process Task / Agent tool stays disabled by design; never route work through it.

Solo, careful execution is fine for trivial or already-verified steps.
</bridge-ultracode>`;

export function withUltracodeDirective(
  baseFile: string | undefined,
  ultracode: boolean,
): string | undefined {
  if (!ultracode) return baseFile;
  let base = "";
  if (baseFile) {
    try {
      base = readFileSync(baseFile, "utf8");
    } catch {
    }
  }
  const combined = base ? `${base}\n\n${ULTRACODE_DIRECTIVE}` : ULTRACODE_DIRECTIVE;
  return ensureSystemPromptFile(combined) ?? baseFile;
}
