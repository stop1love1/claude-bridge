import type { DetectedScope } from "./detect/types";
import type { RepoProfile } from "./repoProfile";
import { logWarn } from "./log";

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

const MIN_KEYWORD_HITS = 1;

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
  block: string;
  summary: {
    suggested: string;
    reason: string;
    matchedRepo: string;
    matchedStack: string[];
    matchedKeywords: string[];
  };
}

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
    logWarn("team-hint", "buildTeamHint crashed (non-fatal)", { error: (err as Error)?.message ?? String(err) });
    return null;
  }
}
