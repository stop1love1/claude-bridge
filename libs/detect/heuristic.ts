import type { RepoProfile } from "../repoProfile";
import {
  type DetectInput,
  type DetectedScope,
  type Detector,
  type RepoMatch,
} from "./types";
import { countMatches, stripDiacritics } from "./tokenize";

type Role = "frontend" | "backend" | "orchestration";

const ROLE_KEYWORDS: Record<Role, string[]> = {
  frontend: [
    "ui", "component", "page", "view", "frontend", "react", "vue",
    "svelte", "tailwind", "style", "button", "form", "modal", "screen",
    "client", "layout", "design", "css",
    "giao", "dien", "man", "hinh", "trang", "bieu", "mau", "nut", "popup",
    "danh", "sach", "hien", "thi",
  ],
  backend: [
    "api", "endpoint", "controller", "route", "migration", "entity",
    "repository", "service", "dto", "swagger", "prisma", "db",
    "database", "sql", "nestjs", "express", "fastify", "jwt",
    "schema", "model", "seed",
    "dich", "vu", "may", "chu", "lieu", "xac", "thuc", "quyen", "token",
  ],
  orchestration: [
    "bridge", "coordinator", "agent", "orchestrat", "dispatcher",
    "permission",
    "dieu", "phoi", "tac", "tu",
  ],
};

const FEATURE_VOCAB: { feature: string; triggers: string[] }[] = [
  { feature: "auth.login",      triggers: ["login", "signin", "jwt", "oauth", "session", "dang nhap", "xac thuc"] },
  { feature: "auth.signup",     triggers: ["signup", "register", "registration", "dang ky"] },
  { feature: "payments",        triggers: ["payment", "billing", "stripe", "invoice", "subscription", "thanh toan", "hoa don"] },
  { feature: "i18n",            triggers: ["i18n", "locale", "translation", "intl", "ngon ngu", "dich"] },
  { feature: "notifications",   triggers: ["notification", "email", "sms", "mail", "push", "thong bao"] },
  { feature: "messaging",       triggers: ["chat", "message", "conversation", "thread", "tin nhan", "hoi thoai"] },
  { feature: "lms.course",      triggers: ["course", "courses", "khoa hoc", "lop hoc"] },
  { feature: "lms.lesson",      triggers: ["lesson", "lessons", "bai hoc", "bai giang"] },
  { feature: "lms.student",     triggers: ["student", "students", "hoc vien", "hoc sinh"] },
  { feature: "lms.teacher",     triggers: ["teacher", "instructor", "giang vien", "giao vien"] },
  { feature: "lms.quiz",        triggers: ["quiz", "exam", "test", "bai kiem tra", "bai thi"] },
  { feature: "search",          triggers: ["search", "filter", "tim kiem", "loc"] },
  { feature: "upload",          triggers: ["upload", "import", "tai len", "nhap"] },
  { feature: "export",          triggers: ["export", "download", "tai xuong", "xuat"] },
];

const ENTITY_VOCAB: { entity: string; triggers: string[] }[] = [
  { entity: "course",   triggers: ["course", "courses", "khoa hoc", "khoahoc"] },
  { entity: "lesson",   triggers: ["lesson", "lessons", "bai hoc", "baihoc", "bai giang"] },
  { entity: "student",  triggers: ["student", "students", "hoc vien", "hocvien", "hoc sinh"] },
  { entity: "teacher",  triggers: ["teacher", "teachers", "instructor", "giang vien", "giangvien", "giao vien"] },
  { entity: "user",     triggers: ["user", "users", "account", "nguoi dung", "tai khoan"] },
  { entity: "order",    triggers: ["order", "orders", "don hang", "donhang"] },
  { entity: "payment",  triggers: ["payment", "payments", "thanh toan"] },
  { entity: "task",     triggers: ["task", "tasks", "cong viec", "nhiem vu"] },
  { entity: "session",  triggers: ["session", "sessions", "phien"] },
  { entity: "report",   triggers: ["report", "reports", "bao cao"] },
];

const FILE_PATH_RE = /\b(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\b/g;

const PROFILE_KEYWORD_WEIGHT = 1;
const PROFILE_STACK_WEIGHT = 2;
const PROFILE_FEATURE_WEIGHT = 3;
const PROFILE_CAPABILITY_WEIGHT = 4;
const ROLE_BUCKET_WEIGHT = 1;

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

interface RepoScore {
  repo: string;
  score: number;
  hits: string[];
  topReason: string;
}

function scoreRepos(
  taskText: string,
  repos: string[],
  profiles: Record<string, RepoProfile> | undefined,
  capabilities: Record<string, string[]> | undefined,
): RepoScore[] {
  const out: RepoScore[] = [];
  if (!taskText.trim() || repos.length === 0) return out;

  for (const repo of repos) {
    const profile = profiles?.[repo];
    const repoCaps = capabilities?.[repo] ?? [];
    const slot: RepoScore = { repo, score: 0, hits: [], topReason: "" };

    let bestContribLabel = "";
    let bestContribValue = 0;
    const noteContrib = (label: string, value: number) => {
      if (value > bestContribValue) {
        bestContribValue = value;
        bestContribLabel = label;
      }
    };

    const roles = classifyRepoRoles(profile);
    for (const role of roles) {
      let bestKw = "";
      let bestKwCount = 0;
      for (const kw of ROLE_KEYWORDS[role]) {
        const count = countMatches(taskText, kw);
        if (count > 0) {
          slot.score += count * ROLE_BUCKET_WEIGHT;
          slot.hits.push(`${role}:${kw}×${count}`);
          if (count > bestKwCount) {
            bestKwCount = count;
            bestKw = kw;
          }
        }
      }
      if (bestKw) noteContrib(`${role}:${bestKw}×${bestKwCount}`, bestKwCount);
    }

    if (profile) {
      for (const kw of profile.keywords) {
        if (kw.length < 3) continue;
        const count = countMatches(taskText, kw);
        if (count > 0) {
          const add = count * PROFILE_KEYWORD_WEIGHT;
          slot.score += add;
          slot.hits.push(`profile:${kw}×${count}`);
          noteContrib(`profile-keyword:${kw}×${count}`, add);
        }
      }
      for (const tok of profile.stack) {
        const count = countMatches(taskText, tok);
        if (count > 0) {
          const add = count * PROFILE_STACK_WEIGHT;
          slot.score += add;
          slot.hits.push(`stack:${tok}×${count}`);
          noteContrib(`stack:${tok}×${count}`, add);
        }
      }
      for (const tok of profile.features) {
        const count = countMatches(taskText, tok);
        if (count > 0) {
          const add = count * PROFILE_FEATURE_WEIGHT;
          slot.score += add;
          slot.hits.push(`feature:${tok}×${count}`);
          noteContrib(`feature:${tok}×${count}`, add);
        }
      }
    }

    for (const cap of repoCaps) {
      const fragments = cap.split(/[.:/_-]+/g).filter((f) => f.length >= 3);
      let capHit = false;
      for (const frag of fragments) {
        const count = countMatches(taskText, frag);
        if (count > 0) {
          const add = count * PROFILE_CAPABILITY_WEIGHT;
          slot.score += add;
          slot.hits.push(`capability:${cap}/${frag}×${count}`);
          noteContrib(`capability:${cap}×${count}`, add);
          capHit = true;
        }
      }
      if (!capHit) {
        const count = countMatches(taskText, cap);
        if (count > 0) {
          const add = count * PROFILE_CAPABILITY_WEIGHT;
          slot.score += add;
          slot.hits.push(`capability:${cap}×${count}`);
          noteContrib(`capability:${cap}×${count}`, add);
        }
      }
    }

    if (bestContribLabel) slot.topReason = bestContribLabel;
    out.push(slot);
  }

  return out;
}

function detectFeatures(
  taskText: string,
  capabilities: Record<string, string[]> | undefined,
): string[] {
  const found = new Set<string>();
  for (const { feature, triggers } of FEATURE_VOCAB) {
    for (const t of triggers) {
      if (countMatches(taskText, t) > 0) {
        found.add(feature);
        break;
      }
    }
  }
  if (capabilities) {
    for (const caps of Object.values(capabilities)) {
      for (const cap of caps) {
        if (countMatches(taskText, cap) > 0) {
          found.add(cap);
        }
      }
    }
  }
  return [...found];
}

function detectEntities(taskText: string): string[] {
  const found = new Set<string>();
  for (const { entity, triggers } of ENTITY_VOCAB) {
    for (const t of triggers) {
      if (countMatches(taskText, t) > 0) {
        found.add(entity);
        break;
      }
    }
  }
  return [...found];
}

function detectFiles(taskText: string): string[] {
  const matches = taskText.match(FILE_PATH_RE) ?? [];
  const out = new Set<string>();
  for (const m of matches) {
    if (/^\d+(\.\d+)+$/.test(m)) continue;
    if (m.startsWith("node_modules/")) continue;
    if (m.length > 200) continue;
    out.add(m);
  }
  return [...out];
}

function buildSignalText(input: DetectInput): string {
  const title = (input.taskTitle ?? "").trim();
  const body = (input.taskBody ?? "").trim();
  if (title && body) return `${title}\n${title}\n${body}`;
  return title || body;
}

function pickConfidence(top: RepoScore | undefined, second: RepoScore | undefined): "high" | "medium" | "low" {
  if (!top || top.score === 0) return "low";
  if (!second || second.score === 0) return "medium";
  return top.score >= second.score * 2 ? "medium" : "low";
}

export function detectScopeSync(input: DetectInput): DetectedScope {
  const text = buildSignalText(input);
  if (!text || input.repos.length === 0) {
    return {
      repos: [],
      features: [],
      entities: [],
      files: [],
      confidence: "low",
      source: "heuristic",
      detectedAt: new Date().toISOString(),
      reason: "empty input or no candidate repos",
    };
  }

  const scored = scoreRepos(text, input.repos, input.profiles, input.capabilities);
  scored.sort((a, b) => b.score - a.score);

  let repoMatches: RepoMatch[] = scored
    .filter((s) => s.score > 0)
    .map((s) => ({
      name: s.repo,
      score: s.score,
      reason: s.topReason || `hits: ${s.hits.slice(0, 4).join(", ")}`,
    }));

  let source: DetectedScope["source"] = "heuristic";
  if (input.pinnedRepo && input.repos.includes(input.pinnedRepo)) {
    source = "user-pinned";
    const existing = repoMatches.find((r) => r.name === input.pinnedRepo);
    const pinned: RepoMatch = existing ?? {
      name: input.pinnedRepo,
      score: 0,
      reason: "user-pinned via NewSessionDialog",
    };
    repoMatches = [
      { ...pinned, reason: `user-pinned (${pinned.reason})` },
      ...repoMatches.filter((r) => r.name !== input.pinnedRepo),
    ];
  }

  const top = scored[0];
  const second = scored[1];
  const confidence = source === "user-pinned" ? "high" : pickConfidence(top, second);

  const features = detectFeatures(text, input.capabilities);
  const entities = detectEntities(text);
  const files = detectFiles(input.taskBody ?? "");

  let reason: string;
  if (source === "user-pinned") {
    reason = `user pinned \`${input.pinnedRepo}\`; heuristic top would be ${top ? `\`${top.repo}\` (score ${top.score})` : "(no signal)"}`;
  } else if (!top || top.score === 0) {
    reason = "heuristic: no clear match";
  } else if (second && second.score === top.score) {
    reason = `heuristic: tie between ${top.repo} and ${second.repo}`;
  } else {
    reason = `heuristic top: ${top.topReason || top.hits.slice(0, 4).join(", ")}`;
  }

  return {
    repos: repoMatches,
    features,
    entities,
    files,
    confidence,
    source,
    detectedAt: new Date().toISOString(),
    reason,
  };
}

export const heuristicDetector: Detector = {
  async detect(input: DetectInput): Promise<DetectedScope> {
    return detectScopeSync(input);
  },
};

export const __test = {
  ROLE_KEYWORDS,
  FEATURE_VOCAB,
  ENTITY_VOCAB,
  scoreRepos,
  detectFeatures,
  detectEntities,
  detectFiles,
  stripDiacritics,
};
