import type { RepoProfile } from "../repoProfile";
import type { DetectedScope } from "./types";

export interface RenderOpts {
  profiles?: Record<string, RepoProfile>;
  forCoordinator?: boolean;
}

const MAX_REPO_LINES = 8;
const MAX_FEATURES = 12;
const MAX_ENTITIES = 12;
const MAX_FILES = 8;

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
