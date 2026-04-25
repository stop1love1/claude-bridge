import { describe, it, expect } from "bun:test";
import { suggestRepo, classifyRepoRoles } from "../repoHeuristic";
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
  features: ["auth"],
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

describe("classifyRepoRoles", () => {
  it("classifies a NestJS/Prisma profile as backend only", () => {
    expect(classifyRepoRoles(apiProfile)).toEqual(["backend"]);
  });

  it("classifies a Next/Tailwind profile as frontend only", () => {
    expect(classifyRepoRoles(webProfile)).toEqual(["frontend"]);
  });

  it("classifies an orchestration repo exclusively (suppresses fe/be)", () => {
    expect(classifyRepoRoles(bridgeProfile)).toEqual(["orchestration"]);
  });

  it("returns empty when no profile is provided", () => {
    expect(classifyRepoRoles(undefined)).toEqual([]);
  });
});

describe("suggestRepo", () => {
  const repos = ["app-web", "app-api", "claude-bridge"];
  const profiles = {
    "app-web": webProfile,
    "app-api": apiProfile,
    "claude-bridge": bridgeProfile,
  };

  it("picks a backend-stacked repo for backend-flavored prompts", () => {
    const out = suggestRepo(
      "Add a new endpoint POST /users/me with a Prisma migration and a JWT-protected controller.",
      repos,
      profiles,
    );
    expect(out.repo).toBe("app-api");
    expect(out.score).toBeGreaterThan(0);
  });

  it("picks a frontend-stacked repo for frontend-flavored prompts", () => {
    const out = suggestRepo(
      "Build a React component with Tailwind that renders a form modal on the dashboard page.",
      repos,
      profiles,
    );
    expect(out.repo).toBe("app-web");
    expect(out.score).toBeGreaterThan(0);
  });

  it("picks the orchestration repo for bridge-flavored prompts", () => {
    const out = suggestRepo(
      "Update the coordinator agent to write meta.json after spawning a child via the bridge permission popup.",
      repos,
      profiles,
    );
    expect(out.repo).toBe("claude-bridge");
    expect(out.score).toBeGreaterThan(0);
  });

  it("returns null when the prompt has no recognizable signal", () => {
    const out = suggestRepo("Please write a haiku about elephants.", repos, profiles);
    expect(out.repo).toBeNull();
    expect(out.reason).toBe("no clear match");
    expect(out.score).toBe(0);
  });

  it("excludes repos not present in the allowlist", () => {
    const out = suggestRepo(
      "Update the bridge coordinator agent and meta.json permission flow.",
      ["app-api"],
      { "app-api": apiProfile },
    );
    expect(out.repo === null || out.repo === "app-api").toBe(true);
  });

  it("returns null when no profiles are passed (no signal)", () => {
    const out = suggestRepo("Add an endpoint", repos, undefined);
    expect(out.repo).toBeNull();
  });
});
