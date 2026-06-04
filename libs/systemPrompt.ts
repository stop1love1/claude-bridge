import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";

/**
 * Content-addressed cache for `--append-system-prompt-file` payloads.
 * Same content → same path → same Anthropic API prompt-cache prefix, so
 * siblings + future spawns reuse the cache. Shared by the agents route
 * (per-app context) and the spawn layer (ultracode directive).
 */
const SYS_PROMPT_CACHE_DIR = join(BRIDGE_STATE_DIR, "cache", "sys-prompts");

/**
 * Write `content` to `.bridge-state/cache/sys-prompts/<sha256>.txt`
 * (idempotent — same content writes to the same path). Returns the
 * absolute path so the caller can pass it to
 * `claude --append-system-prompt-file`, or `null` when content is empty
 * (caller should skip the flag).
 */
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

/**
 * The "Ultracode" tier directive. Claude Code's IDE ultracode mode bundles
 * `--effort xhigh` with the in-process Workflow tool — but that tool is
 * IDE-only and unreachable from the headless `claude -p` children the
 * bridge spawns (verified: no flag/settings enables it in print mode). So
 * the bridge's ultracode tier delivers the `xhigh` effort for real and
 * substitutes the bridge's OWN multi-agent dispatch for "workflows" by
 * appending this directive to the spawned agent's system prompt.
 */
export const ULTRACODE_DIRECTIVE = `<bridge-ultracode>
Ultracode mode is on for this session. Optimize for the most exhaustive, correct outcome — token cost is not a constraint. Do not trade correctness for speed or brevity.

- Decompose the work thoroughly and reason about edge cases before acting.
- Verify your own work: re-read what you changed, run the project's checks, and confirm behavior with evidence rather than asserting it.
- If you coordinate other agents, decompose aggressively and fan out independent work in parallel via the bridge's dispatch API (POST /api/tasks/<id>/agents) and its speculative variants — that is this environment's equivalent of multi-agent workflows. The in-process Task / Agent tool stays disabled by design; never route work through it.

Solo, careful execution is fine for trivial or already-verified steps.
</bridge-ultracode>`;

/**
 * When `ultracode` is on, append {@link ULTRACODE_DIRECTIVE} to the
 * (optional) base system-prompt file and return a NEW content-addressed
 * file path holding the combination. When off, return `baseFile`
 * unchanged. Used by the spawn layer so every spawn path (coordinator /
 * free session / child agent / resume) picks up the directive uniformly,
 * keyed only on the resolved effort level.
 */
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
      /* base file vanished — fall back to the directive alone */
    }
  }
  const combined = base ? `${base}\n\n${ULTRACODE_DIRECTIVE}` : ULTRACODE_DIRECTIVE;
  return ensureSystemPromptFile(combined) ?? baseFile;
}
