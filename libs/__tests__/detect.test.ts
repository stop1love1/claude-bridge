import { describe, it, expect } from "vitest";
import { classifyRepoRoles, detectScopeSync, heuristicDetector } from "../detect/heuristic";
import { renderDetectedScope } from "../detect/render";
import {
  countMatches,
  stripDiacritics,
  tokenize,
  STOPWORDS,
} from "../detect/tokenize";
import { hashTaskBody } from "../detect/cache";
import type { RepoProfile } from "../repoProfile";

function makeProfile(p: Partial<RepoProfile> & Pick<RepoProfile, "name">): RepoProfile {
  return {
    path: `/tmp/${p.name}`,
    summary: p.summary ?? "",
    stack: p.stack ?? [],
    keywords: p.keywords ?? [],
    features: p.features ?? [],
    entrypoints: p.entrypoints ?? [],
    fileCounts: p.fileCounts ?? {},
    refreshedAt: p.refreshedAt ?? new Date().toISOString(),
    signals: p.signals ?? {
      hasPackageJson: false,
      hasReadme: false,
      hasClaudeMd: false,
      hasNextConfig: false,
      hasPrismaSchema: false,
      hasTailwindConfig: false,
      hasNestCoreDep: false,
      hasReactDep: false,
      routerStyle: "unknown",
      primaryLang: "unknown",
    },
    ...p,
  };
}

const apiProfile = makeProfile({
  name: "app-api",
  summary: "NestJS API",
  stack: ["nestjs", "prisma", "typescript"],
  features: ["auth", "lms"],
  keywords: ["course", "lesson", "student"],
  signals: {
    hasPackageJson: true,
    hasReadme: false,
    hasClaudeMd: false,
    hasNextConfig: false,
    hasPrismaSchema: true,
    hasTailwindConfig: false,
    hasNestCoreDep: true,
    hasReactDep: false,
    routerStyle: "src",
    primaryLang: "ts",
  },
});

const webProfile = makeProfile({
  name: "app-web",
  summary: "Next frontend",
  stack: ["next", "tailwindcss", "typescript"],
  features: [],
  keywords: ["course", "lesson"],
  signals: {
    hasPackageJson: true,
    hasReadme: false,
    hasClaudeMd: false,
    hasNextConfig: true,
    hasPrismaSchema: false,
    hasTailwindConfig: true,
    hasNestCoreDep: false,
    hasReactDep: true,
    routerStyle: "app",
    primaryLang: "ts",
  },
});

describe("tokenize", () => {
  it("strips Vietnamese diacritics so 'khóa' matches 'khoa'", () => {
    expect(stripDiacritics("Khóa học đăng nhập")).toBe("Khoa hoc dang nhap");
  });

  it("drops stopwords + short tokens + numerics", () => {
    const out = tokenize("Add the new login page for users");
    expect(out).toContain("login");
    expect(out).toContain("new");
    expect(out).toContain("users");
    expect(out).not.toContain("add");
    expect(out).not.toContain("the");
    expect(out).not.toContain("for");
    expect(out).not.toContain("page");
  });

  it("tokenizes a Vietnamese task body", () => {
    const out = tokenize("Thêm trang đăng nhập cho học viên");
    expect(out).toContain("dang");
    expect(out).toContain("nhap");
    expect(out).toContain("hoc");
    expect(out).toContain("vien");
    expect(out).not.toContain("them");
    expect(out).not.toContain("trang");
  });

  it("STOPWORDS contains both English and Vietnamese tokens", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("them")).toBe(true);
    expect(STOPWORDS.has("trang")).toBe(true);
  });
});

describe("countMatches", () => {
  it("matches case-insensitively + diacritic-insensitively", () => {
    expect(countMatches("Khóa học đăng nhập", "khoa hoc")).toBe(1);
    expect(countMatches("LOGIN page", "login")).toBe(1);
  });

  it("counts overlapping tokens once per non-overlap", () => {
    expect(countMatches("course course course", "course")).toBe(3);
  });

  it("returns 0 for empty needle / no match", () => {
    expect(countMatches("anything", "")).toBe(0);
    expect(countMatches("nothing here", "course")).toBe(0);
  });
});

describe("heuristicDetector", () => {
  it("picks the backend repo for an API task", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Add a /courses endpoint with JWT auth",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": apiProfile, "app-web": webProfile },
    });
    expect(scope.repos.length).toBeGreaterThan(0);
    expect(scope.repos[0].name).toBe("app-api");
    expect(scope.source).toBe("heuristic");
  });

  it("picks the frontend repo for a UI task", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Build the course list page with a search button",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": apiProfile, "app-web": webProfile },
    });
    expect(scope.repos[0].name).toBe("app-web");
  });

  it("understands Vietnamese task bodies", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Thêm màn hình đăng nhập cho học viên",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": apiProfile, "app-web": webProfile },
    });
    expect(scope.repos[0].name).toBe("app-web");
  });

  it("detects bilingual entities", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Sửa trang khóa học và bài học cho giảng viên",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": apiProfile, "app-web": webProfile },
    });
    expect(scope.entities).toContain("course");
    expect(scope.entities).toContain("lesson");
    expect(scope.entities).toContain("teacher");
  });

  it("detects bilingual features", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Tích hợp đăng nhập bằng Google cho khóa học",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    expect(scope.features).toContain("auth.login");
    expect(scope.features).toContain("lms.course");
  });

  it("respects user-pinned repo even when score would route elsewhere", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Add /api/auth/login endpoint with JWT",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": apiProfile, "app-web": webProfile },
      pinnedRepo: "app-web",
    });
    expect(scope.repos[0].name).toBe("app-web");
    expect(scope.source).toBe("user-pinned");
    expect(scope.confidence).toBe("high");
  });

  it("boosts repos via declared capabilities", async () => {
    const noKwApi = makeProfile({ ...apiProfile, keywords: [], features: [] });
    const noKwWeb = makeProfile({ ...webProfile, keywords: [], features: [] });
    const scope = await heuristicDetector.detect({
      taskBody: "Update billing flow to support annual subscription",
      repos: ["app-api", "app-web"],
      profiles: { "app-api": noKwApi, "app-web": noKwWeb },
      capabilities: { "app-api": ["billing.subscription"] },
    });
    expect(scope.repos[0].name).toBe("app-api");
    expect(scope.repos[0].reason).toMatch(/capability/);
  });

  it("returns empty repos when no signal AND no profiles", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Just some words.",
      repos: ["app-api", "app-web"],
    });
    expect(scope.repos).toHaveLength(0);
    expect(scope.confidence).toBe("low");
  });

  it("extracts file paths verbatim", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Update src/auth/login.ts and components/Header.tsx to support 2FA",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    expect(scope.files).toContain("src/auth/login.ts");
    expect(scope.files).toContain("components/Header.tsx");
  });

  it("filters version strings out of files", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Bump dep to 4.2.1",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    expect(scope.files).not.toContain("4.2.1");
  });
});

describe("renderDetectedScope", () => {
  it("emits a Detected scope heading + source / confidence / reason", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Add /courses endpoint",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    const md = renderDetectedScope(scope);
    expect(md).toMatch(/^## Detected scope/);
    expect(md).toMatch(/Source: `heuristic`/);
    expect(md).toMatch(/Confidence:/);
    expect(md).toMatch(/Reason:/);
    expect(md).toMatch(/`app-api`/);
  });

  it("omits empty sections (features / entities / files)", async () => {
    const scope = await heuristicDetector.detect({
      taskBody: "Just some random text with nothing notable",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    const md = renderDetectedScope(scope);
    if (scope.features.length === 0) expect(md).not.toMatch(/### Features/);
    if (scope.entities.length === 0) expect(md).not.toMatch(/### Entities/);
    if (scope.files.length === 0) expect(md).not.toMatch(/### Files/);
  });

  it("renders profile bullets when profiles are passed", () => {
    const md = renderDetectedScope(
      {
        repos: [{ name: "app-api", score: 5, reason: "test" }],
        features: [],
        entities: [],
        files: [],
        confidence: "medium",
        source: "heuristic",
        detectedAt: new Date().toISOString(),
        reason: "test",
      },
      { profiles: { "app-api": apiProfile } },
    );
    expect(md).toMatch(/### Repo profiles/);
    expect(md).toMatch(/NestJS API/);
  });
});

describe("hashTaskBody", () => {
  it("returns a stable 16-char hex hash", () => {
    const a = hashTaskBody("hello");
    const b = hashTaskBody("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("distinguishes different inputs", () => {
    expect(hashTaskBody("hello")).not.toBe(hashTaskBody("world"));
  });
});

describe("classifyRepoRoles", () => {
  const orchestrationProfile = makeProfile({
    name: "claude-bridge",
    summary: "orchestrator",
    stack: ["next", "react"],
    features: ["orchestration"],
    signals: {
      hasPackageJson: true,
      hasReadme: false,
      hasClaudeMd: false,
      hasNextConfig: true,
      hasPrismaSchema: false,
      hasTailwindConfig: false,
      hasNestCoreDep: false,
      hasReactDep: true,
      routerStyle: "app",
      primaryLang: "ts",
    },
  });

  it("classifies a NestJS/Prisma profile as backend only", () => {
    expect(classifyRepoRoles(apiProfile)).toEqual(["backend"]);
  });

  it("classifies a Next/Tailwind profile as frontend only", () => {
    expect(classifyRepoRoles(webProfile)).toEqual(["frontend"]);
  });

  it("classifies an orchestration repo exclusively (suppresses fe/be)", () => {
    expect(classifyRepoRoles(orchestrationProfile)).toEqual(["orchestration"]);
  });

  it("returns empty when no profile is provided", () => {
    expect(classifyRepoRoles(undefined)).toEqual([]);
  });
});

describe("detectScopeSync — sync core (mirrors heuristicDetector.detect)", () => {
  const bridgeProfile = makeProfile({
    name: "claude-bridge",
    summary: "orchestrator",
    stack: ["next", "react"],
    features: ["orchestration"],
    signals: {
      hasPackageJson: true,
      hasReadme: false,
      hasClaudeMd: false,
      hasNextConfig: true,
      hasPrismaSchema: false,
      hasTailwindConfig: false,
      hasNestCoreDep: false,
      hasReactDep: true,
      routerStyle: "app",
      primaryLang: "ts",
    },
  });
  const repos = ["app-web", "app-api", "claude-bridge"];
  const profiles = { "app-web": webProfile, "app-api": apiProfile, "claude-bridge": bridgeProfile };

  it("picks a backend-stacked repo for backend-flavored prompts", () => {
    const scope = detectScopeSync({
      taskBody: "Add a new endpoint POST /users/me with a Prisma migration and a JWT-protected controller.",
      repos,
      profiles,
    });
    expect(scope.repos[0]?.name).toBe("app-api");
    expect(scope.repos[0]?.score).toBeGreaterThan(0);
  });

  it("picks a frontend-stacked repo for frontend-flavored prompts", () => {
    const scope = detectScopeSync({
      taskBody: "Build a React component with Tailwind that renders a form modal on the dashboard page.",
      repos,
      profiles,
    });
    expect(scope.repos[0]?.name).toBe("app-web");
    expect(scope.repos[0]?.score).toBeGreaterThan(0);
  });

  it("picks the orchestration repo for bridge-flavored prompts", () => {
    const scope = detectScopeSync({
      taskBody: "Update the coordinator agent to write meta.json after spawning a child via the bridge permission popup.",
      repos,
      profiles,
    });
    expect(scope.repos[0]?.name).toBe("claude-bridge");
    expect(scope.repos[0]?.score).toBeGreaterThan(0);
  });

  it("returns no repos when the prompt has no recognizable signal", () => {
    const scope = detectScopeSync({ taskBody: "Please write a haiku about elephants.", repos, profiles });
    expect(scope.repos).toHaveLength(0);
    expect(scope.reason).toBe("heuristic: no clear match");
  });

  it("excludes repos not present in the allowlist", () => {
    const scope = detectScopeSync({
      taskBody: "Update the bridge coordinator agent and meta.json permission flow.",
      repos: ["app-api"],
      profiles: { "app-api": apiProfile },
    });
    expect(scope.repos[0]?.name === undefined || scope.repos[0]?.name === "app-api").toBe(true);
  });

  it("returns no repos when no profiles are passed (no signal)", () => {
    const scope = detectScopeSync({ taskBody: "Add an endpoint", repos, profiles: undefined });
    expect(scope.repos).toHaveLength(0);
  });
});
