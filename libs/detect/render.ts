/**
 * Render a `DetectedScope` into a single canonical markdown block.
 *
 * One renderer is used by both the coordinator prompt
 * (`lib/coordinator.ts`) and every child prompt (`lib/childPrompt.ts`),
 * so coordinator and children always see the SAME detected scope.
 * This is the contract that closes the drift between the two layers.
 *
 * Replaces the legacy:
 *   - `## Bridge hint`     (coordinator prompt)
 *   - `## Repo profiles`   (coordinator prompt)
 * with a single `## Detected scope` heading.
 *
 * The block is intentionally compact — coordinator agents read it once
 * and decide; children read it as background. We use sentence-shaped
 * bullets rather than tables for tokenizer-friendliness.
 */
import type { RepoProfile } from "../repoProfile";
import type { DetectedScope } from "./types";

export interface RenderOpts {
  /**
   * Per-repo profiles (one bullet per profile is appended after the
   * scope summary so the coordinator sees what each candidate repo
   * actually looks like). Optional — block still works without.
   */
  profiles?: Record<string, RepoProfile>;
  /**
   * When true, append a longer "How to read this" footer suitable for
   * the coordinator prompt. Children get the terse version.
   */
  forCoordinator?: boolean;
}

const MAX_REPO_LINES = 8;
const MAX_FEATURES = 12;
const MAX_ENTITIES = 12;
const MAX_FILES = 8;

/**
 * Build the `## Detected scope` markdown block. Pure function — no I/O.
 *
 * Output shape (sections marked OPT-IN are skipped when empty):
 *   ## Detected scope
 *   - Source: heuristic | llm | user-pinned
 *   - Confidence: high | medium | low
 *   - Reason: <one-line>
 *   ### Repos
 *   - <name> (score N) — <reason>     # OPT-IN
 *   ### Features                       # OPT-IN
 *   ### Entities                       # OPT-IN
 *   ### Files mentioned                # OPT-IN
 *   ### Repo profiles                  # OPT-IN, only when profiles passed
 */
export function renderDetectedScope(
  scope: DetectedScope,
  opts: RenderOpts = {},
): string {
  const lines: string[] = [];
  lines.push("## Detected scope");
  lines.push("");
  lines.push(`- Source: \`${scope.source}\``);
  lines.push(`- Confidence: \`${scope.confidence}\``);
  lines.push(`- Reason: ${scope.reason || "(none)"}`);
  lines.push("");

  if (scope.repos.length > 0) {
    lines.push("### Repos (in priority order)");
    lines.push("");
    for (const r of scope.repos.slice(0, MAX_REPO_LINES)) {
      lines.push(
        `- **\`${r.name}\`** (score ${r.score}) — ${r.reason || "(no detail)"}`,
      );
    }
    if (scope.repos.length > MAX_REPO_LINES) {
      lines.push(`- …and ${scope.repos.length - MAX_REPO_LINES} more (truncated).`);
    }
    lines.push("");
  } else {
    lines.push("### Repos");
    lines.push("");
    lines.push(
      "- (no candidate repo scored above zero — pick from the profiles below based on the task body itself)",
    );
    lines.push("");
  }

  if (scope.features.length > 0) {
    lines.push("### Features");
    lines.push("");
    const shown = scope.features.slice(0, MAX_FEATURES);
    lines.push(`- ${shown.map((f) => `\`${f}\``).join(", ")}`);
    if (scope.features.length > MAX_FEATURES) {
      lines.push(`- …and ${scope.features.length - MAX_FEATURES} more.`);
    }
    lines.push("");
  }

  if (scope.entities.length > 0) {
    lines.push("### Entities");
    lines.push("");
    const shown = scope.entities.slice(0, MAX_ENTITIES);
    lines.push(`- ${shown.map((e) => `\`${e}\``).join(", ")}`);
    if (scope.entities.length > MAX_ENTITIES) {
      lines.push(`- …and ${scope.entities.length - MAX_ENTITIES} more.`);
    }
    lines.push("");
  }

  if (scope.files.length > 0) {
    lines.push("### Files mentioned");
    lines.push("");
    for (const f of scope.files.slice(0, MAX_FILES)) {
      lines.push(`- \`${f}\``);
    }
    if (scope.files.length > MAX_FILES) {
      lines.push(`- …and ${scope.files.length - MAX_FILES} more.`);
    }
    lines.push("");
  }

  // Repo profiles — only emitted when caller supplied them. The
  // coordinator passes them so it sees the full contract surface;
  // children typically don't need them since they only run in one
  // repo and already have its profile rendered separately.
  if (opts.profiles) {
    const names = Object.keys(opts.profiles).sort();
    if (names.length > 0) {
      lines.push("### Repo profiles");
      lines.push("");
      for (const name of names) {
        const p = opts.profiles[name];
        if (!p) continue;
        const summary = p.summary?.trim() || `${p.name} — (no summary)`;
        const stack = p.stack.length > 0 ? p.stack.join(", ") : "(unknown)";
        const features = p.features.length > 0 ? p.features.join(", ") : "(none detected)";
        const entrypoints = p.entrypoints.length > 0
          ? p.entrypoints.slice(0, 4).join(", ")
          : "(unknown)";
        lines.push(
          `- **${p.name}** — ${summary} Stack: ${stack}. Features: ${features}. Entrypoints: ${entrypoints}.`,
        );
      }
      lines.push("");
    }
  }

  if (opts.forCoordinator) {
    lines.push(
      "Treat the top repo as a starting recommendation — override only if the task body genuinely contradicts it (and explain the override in your final summary).",
      "",
    );
  }

  return lines.join("\n");
}
