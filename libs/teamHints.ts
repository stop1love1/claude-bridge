/**
 * Auto-suggested team shape — surfaces a `## Suggested team` block into
 * the coordinator's prompt when the task body + repo profile combination
 * matches a known pattern that benefits from a specific multi-agent
 * shape.
 *
 * Pattern A — UX/UI work on a frontend-stack repo:
 *   coordinator should default to `coder → ui-tester`. The coder lands
 *   the change; the ui-tester drives the rendered UI through Playwright
 *   MCP to verify the flow actually works end-to-end (typecheck/lint
 *   only catches code-level issues, not whether a button is clickable).
 *
 * The coordinator is free to override — this is a HINT, not a directive.
 * The `## Suggested team` block opens with "Auto-detected suggestion"
 * framing so the coordinator knows it can be overruled by the playbook
 * rubric in §2 when the task body genuinely calls for a different shape.
 */
import type { DetectedScope } from "./detect/types";
import type { RepoProfile } from "./repoProfile";

/** Stack tokens that mean "this repo renders user-facing UI". */
const FE_STACK_TOKENS = new Set([
  "next", "next.js", "nextjs",
  "react",
  "vue", "vue.js", "vuejs",
  "svelte", "sveltekit",
  "solid", "solidjs",
  "tailwind", "tailwindcss",
  "antd", "ant-design",
  "mui", "material-ui",
  "chakra", "chakra-ui",
]);

/**
 * Keywords that strongly imply user-facing UX work. Mixed Vietnamese
 * + English so a Vietnamese task body ("sửa modal", "trang refunds")
 * matches the same way an English one ("fix the modal", "refunds page")
 * does. Matched case-insensitive, word-boundary OR substring depending
 * on the entry — short tokens use word-boundary, longer phrases match
 * as substrings.
 */
const UX_KEYWORDS_EN: readonly string[] = [
  "UI", "UX",
  "page", "screen", "view",
  "form", "modal", "popup", "dialog", "drawer",
  "button", "link", "menu", "navbar", "sidebar",
  "table", "card", "list",
  "tooltip", "snackbar", "toast", "notification",
  "filter", "search", "sort",
  "tab", "stepper", "wizard",
  "icon", "badge", "chip", "avatar",
  "empty state",
  "layout", "responsive",
  "flow", "wizard",
  "accessibility", "a11y",
  "render", "click", "hover",
];

const UX_KEYWORDS_VI: readonly string[] = [
  "giao diện", "màn hình", "trang",
  "biểu mẫu", "popup",
  "nút", "thanh điều hướng", "thanh menu",
  "bảng", "thẻ", "danh sách",
  "lọc", "tìm kiếm", "sắp xếp",
  "tab", "bước",
  "trạng thái rỗng",
  "bố cục",
  "điều hướng",
];

/** Min UX keyword hits before the suggestion fires. Tunable via env. */
const MIN_KEYWORD_HITS = 1;

/**
 * True iff at least one repo in the detected scope has an FE-stack
 * signature. Looks at the top-scored repo's profile; falls back to false
 * when no profile is cached for that name (cold start, unregistered repo).
 */
function hasFrontendStack(
  scope: DetectedScope | null,
  profiles: Record<string, RepoProfile> | undefined,
): { ok: boolean; matchedRepo: string | null; matchedStack: string[] } {
  if (!scope || !profiles) {
    return { ok: false, matchedRepo: null, matchedStack: [] };
  }
  for (const r of scope.repos) {
    const p = profiles[r.name];
    if (!p) continue;
    const matched = p.stack.filter((s) =>
      FE_STACK_TOKENS.has(s.toLowerCase()),
    );
    if (matched.length > 0) {
      return { ok: true, matchedRepo: r.name, matchedStack: matched };
    }
  }
  return { ok: false, matchedRepo: null, matchedStack: [] };
}

/**
 * Count UX-keyword hits in the task body. Case-insensitive. English
 * tokens of length ≤4 (UI, UX, tab, form, view, card, …) match on
 * word boundaries to avoid false positives (e.g. "form" inside
 * "format"); longer entries match as plain substrings.
 */
function countUxHits(body: string): { hits: number; samples: string[] } {
  const text = body || "";
  const lower = text.toLowerCase();
  const samples: string[] = [];

  for (const kw of UX_KEYWORDS_EN) {
    const k = kw.toLowerCase();
    let found = false;
    if (k.length <= 4) {
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      found = re.test(text);
    } else {
      found = lower.includes(k);
    }
    if (found) samples.push(kw);
  }
  for (const kw of UX_KEYWORDS_VI) {
    if (lower.includes(kw.toLowerCase())) samples.push(kw);
  }

  return { hits: samples.length, samples: samples.slice(0, 6) };
}

export interface TeamHintArgs {
  taskBody: string;
  detectedScope: DetectedScope | null;
  profiles: Record<string, RepoProfile> | undefined;
}

export interface TeamHint {
  /** Markdown block to splice into the coordinator's prompt. */
  block: string;
  /** Programmatic summary callers can log. */
  summary: {
    suggested: string;
    reason: string;
    matchedRepo: string;
    matchedStack: string[];
    matchedKeywords: string[];
  };
}

/**
 * Build the `## Suggested team` block for the given task + scope, or
 * return null when no rule matches. Currently surfaces only the
 * coder→ui-tester pattern; add more rules here as patterns emerge.
 *
 * Defaults to null on any parsing failure — this is an opt-in hint, not
 * a hard requirement. A crash here must never block the coordinator from
 * spawning.
 */
export function buildTeamHint(args: TeamHintArgs): TeamHint | null {
  try {
    const { taskBody, detectedScope, profiles } = args;
    const fe = hasFrontendStack(detectedScope, profiles);
    if (!fe.ok) return null;

    const ux = countUxHits(taskBody);
    if (ux.hits < MIN_KEYWORD_HITS) return null;

    const reason = `task body has ${ux.hits} UX keyword(s) (${ux.samples.join(", ")}) and target repo \`${fe.matchedRepo}\` has FE stack (${fe.matchedStack.join(", ")})`;
    const block = [
      "## Suggested team (auto-detected)",
      "",
      "Based on the task body + repo profile, the bridge recommends the following team shape — **`coder` → `ui-tester`**:",
      "",
      `- **Why:** ${reason}.`,
      "- **`coder`** lands the change (forms/components/styling/state).",
      "- **`ui-tester`** drives the rendered UI through Playwright MCP after the coder exits, verifying the flow actually works end-to-end. Unit tests and typecheck only catch code-level regressions; the tester catches \"the button is dead\" / \"the modal never opens\" / \"the table column overflows\" classes of bugs.",
      "",
      "This is a hint — overrule it when the task body genuinely calls for a different shape (pure refactor with no rendered output, config change, doc fix). For matching tasks, the default flow is:",
      "",
      "1. Dispatch `coder` first; wait for it to finish cleanly.",
      "2. Dispatch `ui-tester` with a brief that names the route(s) and acceptance criteria to verify. The bridge auto-injects the ui-tester playbook (`prompts/playbooks/ui-tester.md`), so your brief is just the role-specific instructions.",
      "3. If the tester returns `BLOCKED` or finds bugs, follow with a `fixer` whose brief embeds the tester's `## Notes for the coordinator` section verbatim.",
      "",
    ].join("\n");

    return {
      block,
      summary: {
        suggested: "coder → ui-tester",
        reason,
        matchedRepo: fe.matchedRepo ?? "",
        matchedStack: fe.matchedStack,
        matchedKeywords: ux.samples,
      },
    };
  } catch (err) {
    // Hint generation never blocks spawning — log and degrade silently.
    console.warn("[team-hint] buildTeamHint crashed (non-fatal)", err);
    return null;
  }
}
