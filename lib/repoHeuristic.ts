/**
 * Auto-detect repo target from a child-spawn prompt when the caller
 * (the coordinator, usually) didn't specify `repo`. Cheap, transparent,
 * no LLM call: keyword frequency tally per repo, weighted by a role
 * classification derived purely from the repo's `RepoProfile`.
 *
 * Design goals:
 *  - **No hardcoded repo names.** Switching the bridge to a different
 *    project must work without code changes — every signal comes from
 *    `BRIDGE.md` (the allowlist) and `RepoProfile` (auto-scanned stack /
 *    features / keywords).
 *  - **Two scoring layers** that sum:
 *     1. *Role buckets* — generic frontend / backend / orchestration
 *        keywords scored against repos whose profile classifies them
 *        into that role (e.g. a repo with `next` in its stack picks up
 *        UI keyword hits; a repo with `nestjs` or `prisma` picks up API
 *        keyword hits; a repo with the `orchestration` feature picks up
 *        bridge / coordinator keyword hits).
 *     2. *Profile boost* — direct hits on the repo's own keywords /
 *        stack tokens / features (a course-domain repo gets boosted
 *        when the prompt mentions courses).
 *
 * If a repo has no profile AND no role classification, it scores 0 and
 * never wins — explicit `repo` is the escape hatch in that case.
 */

import type { RepoProfile } from "./repoProfile";

type Role = "frontend" | "backend" | "orchestration";

/**
 * Generic role keywords. These are stable across projects — they
 * describe the *kind of work* a prompt is asking for, not which named
 * repo holds it. The role-to-repo mapping is derived per-repo from its
 * profile, not hardcoded here.
 */
const ROLE_KEYWORDS: Record<Role, string[]> = {
  frontend: [
    "ui", "component", "page", "view", "frontend", "fe", "react", "vue",
    "svelte", "tailwind", "style", "button", "form", "modal", "screen",
    "tsx", "jsx", "css", "client",
  ],
  backend: [
    "api", "endpoint", "controller", "route", "migration", "entity",
    "repository", "service", "dto", "swagger", "prisma", "db",
    "database", "sql", "nestjs", "express", "fastify", "auth", "jwt",
  ],
  orchestration: [
    "bridge", "coordinator", "agent", "orchestrat", "meta.json",
    "tasks.md", "permission", "dispatcher",
  ],
};

export interface RepoSuggestion {
  repo: string | null;
  reason: string;
  score: number;
}

const PROFILE_KEYWORD_WEIGHT = 1;
const PROFILE_STACK_WEIGHT = 2;
const PROFILE_FEATURE_WEIGHT = 3;
const ROLE_BUCKET_WEIGHT = 1;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let from = 0;
  let count = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

interface RepoScore {
  repo: string;
  score: number;
  hits: string[];
  topReason: string;
}

/**
 * Derive which generic role(s) a repo plays from its `RepoProfile`.
 * Pure function of profile signals — no repo names involved.
 *
 * If the repo has the `orchestration` feature, that role is returned
 * exclusively so a bridge-shaped repo doesn't compete with real
 * frontends / backends on UI- or API-tinted prompts. Otherwise, both
 * `frontend` and `backend` can be assigned (a fullstack repo with both
 * Next and Prisma legitimately serves both buckets).
 */
export function classifyRepoRoles(profile: RepoProfile | undefined): Role[] {
  if (!profile) return [];
  const stack = new Set(profile.stack);
  const features = new Set(profile.features);
  const sig = profile.signals;

  if (features.has("orchestration")) return ["orchestration"];

  const roles: Role[] = [];
  const isFrontend =
    stack.has("next") || stack.has("react") || stack.has("vue") ||
    stack.has("svelte") || stack.has("tailwindcss") ||
    sig.routerStyle === "app" || sig.routerStyle === "pages" ||
    sig.hasReactDep;
  const isBackend =
    stack.has("nestjs") || stack.has("express") || stack.has("prisma") ||
    stack.has("typeorm") || sig.hasNestCoreDep || sig.hasPrismaSchema;

  if (isFrontend) roles.push("frontend");
  if (isBackend) roles.push("backend");
  return roles;
}

/**
 * Score each candidate repo by:
 *   - role-bucket keyword hits (weighted by which roles the profile
 *     classifies the repo into)
 *   - profile-derived boosts (keywords / stack / features)
 *
 * Returns `{ repo: null }` when nothing scored or there's a tie.
 *
 * Only repos in the `repos` allowlist (the BRIDGE.md table) can win.
 * `profiles` is required for any repo to score above zero — without it
 * the heuristic has no signal.
 */
export function suggestRepo(
  promptText: string,
  repos: string[],
  profiles?: Record<string, RepoProfile>,
): RepoSuggestion {
  const text = (promptText ?? "").toLowerCase();
  if (!text.trim() || repos.length === 0) {
    return { repo: null, reason: "no clear match", score: 0 };
  }

  const scoreByRepo = new Map<string, RepoScore>();
  const ensure = (repo: string): RepoScore => {
    let s = scoreByRepo.get(repo);
    if (!s) {
      s = { repo, score: 0, hits: [], topReason: "" };
      scoreByRepo.set(repo, s);
    }
    return s;
  };

  for (const repo of repos) {
    const profile = profiles?.[repo];
    const slot = ensure(repo);

    let bestContribLabel = "";
    let bestContribValue = 0;
    const noteContrib = (label: string, value: number) => {
      if (value > bestContribValue) {
        bestContribValue = value;
        bestContribLabel = label;
      }
    };

    // 1. Role-bucket scoring (profile-driven, no repo name involved).
    const roles = classifyRepoRoles(profile);
    for (const role of roles) {
      let bestKw = "";
      let bestKwCount = 0;
      for (const kw of ROLE_KEYWORDS[role]) {
        const count = countOccurrences(text, kw.toLowerCase());
        if (count > 0) {
          const add = count * ROLE_BUCKET_WEIGHT;
          slot.score += add;
          slot.hits.push(`${role}:${kw}×${count}`);
          if (count > bestKwCount) {
            bestKwCount = count;
            bestKw = kw;
          }
        }
      }
      if (bestKw) noteContrib(`${role}:${bestKw}×${bestKwCount}`, bestKwCount);
    }

    // 2. Profile boost (keywords / stack / features harvested from the
    //    repo itself by `lib/repoProfile.ts`).
    if (profile) {
      for (const kw of profile.keywords) {
        const k = kw.toLowerCase();
        if (k.length < 3) continue;
        const count = countOccurrences(text, k);
        if (count > 0) {
          const add = count * PROFILE_KEYWORD_WEIGHT;
          slot.score += add;
          slot.hits.push(`profile:${kw}×${count}`);
          noteContrib(`profile-keyword:${kw}×${count}`, add);
        }
      }
      for (const tok of profile.stack) {
        const k = tok.toLowerCase();
        const count = countOccurrences(text, k);
        if (count > 0) {
          const add = count * PROFILE_STACK_WEIGHT;
          slot.score += add;
          slot.hits.push(`stack:${tok}×${count}`);
          noteContrib(`stack:${tok}×${count}`, add);
        }
      }
      for (const tok of profile.features) {
        const k = tok.toLowerCase();
        const count = countOccurrences(text, k);
        if (count > 0) {
          const add = count * PROFILE_FEATURE_WEIGHT;
          slot.score += add;
          slot.hits.push(`feature:${tok}×${count}`);
          noteContrib(`feature:${tok}×${count}`, add);
        }
      }
    }

    if (bestContribLabel) slot.topReason = bestContribLabel;
  }

  const scores = [...scoreByRepo.values()].filter((s) => repos.includes(s.repo));
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  if (!top || top.score === 0) {
    return { repo: null, reason: "no clear match", score: 0 };
  }
  const second = scores[1];
  if (second && second.score === top.score) {
    return {
      repo: null,
      reason: `tie between ${top.repo} and ${second.repo}`,
      score: top.score,
    };
  }
  const reason = top.topReason
    ? `top: ${top.topReason}; hits: ${top.hits.slice(0, 6).join(", ")}`
    : `keyword hits: ${top.hits.slice(0, 6).join(", ")}`;
  return {
    repo: top.repo,
    reason,
    score: top.score,
  };
}
