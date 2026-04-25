import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, __test } from "../repoProfile";
import { suggestRepo } from "../repoHeuristic";

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-repoprofile-${label}-`));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.replace(/[\\/][^\\/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

describe("scanRepo — Next + Tailwind + Prisma stack", () => {
  const root = mktmp("next-stack");
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "app-web",
      description: "LMS frontend",
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
        tailwindcss: "^4.0.0",
        "@prisma/client": "^5.0.0",
      },
      devDependencies: { typescript: "^5.0.0", prisma: "^5.0.0" },
    }),
    "next.config.ts": "export default {};",
    "tailwind.config.ts": "export default {};",
    "tsconfig.json": "{}",
    "README.md": "# app-web\n\nNext.js 15 LMS frontend with Tailwind.",
    "app/page.tsx": "export default function Page() { return null; }",
    "app/api/courses/route.ts": "export const GET = () => null;",
    "prisma/schema.prisma": [
      "model Course { id Int @id }",
      "model Lesson { id Int @id }",
      "enum Role { STUDENT TEACHER }",
    ].join("\n"),
  });

  const profile = scanRepo(root);

  it("populates stack with next + tailwindcss + prisma + typescript (omits react when next present)", () => {
    expect(profile.stack).toContain("next");
    expect(profile.stack).toContain("tailwindcss");
    expect(profile.stack).toContain("prisma");
    expect(profile.stack).toContain("typescript");
    expect(profile.stack).not.toContain("react");
  });

  it("primaryLang is ts and routerStyle is app", () => {
    expect(profile.signals.primaryLang).toBe("ts");
    expect(profile.signals.routerStyle).toBe("app");
  });

  it("derives lms feature from prisma + readme", () => {
    expect(profile.features).toContain("lms");
  });

  it("entrypoints reflect Next App router", () => {
    expect(profile.entrypoints).toContain("app/api/**/*.ts");
    expect(profile.entrypoints).toContain("app/**/*.tsx");
  });

  it("captures prisma model names as keywords", () => {
    expect(profile.keywords).toContain("course");
    expect(profile.keywords).toContain("lesson");
  });

  rmSync(root, { recursive: true, force: true });
});

describe("scanRepo — bare repo without package.json", () => {
  const root = mktmp("bare");
  // No files at all; just the directory exists.
  const profile = scanRepo(root);

  it("returns empty stack and a synthesized summary", () => {
    expect(profile.stack).toEqual([]);
    expect(profile.summary).toMatch(/no README found/);
  });

  it("signals reflect missing files", () => {
    expect(profile.signals.hasPackageJson).toBe(false);
    expect(profile.signals.hasReadme).toBe(false);
    expect(profile.signals.hasClaudeMd).toBe(false);
  });

  it("primaryLang falls back to unknown", () => {
    expect(profile.signals.primaryLang).toBe("unknown");
  });

  rmSync(root, { recursive: true, force: true });
});

describe("scanRepo — NestJS API repo", () => {
  const root = mktmp("nest");
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "app-api",
      dependencies: {
        "@nestjs/core": "^10.0.0",
        "@nestjs/common": "^10.0.0",
        "@prisma/client": "^5.0.0",
      },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "CLAUDE.md": "# app-api\n\nNestJS + Prisma backend with JWT auth and student/course endpoints.",
    "src/courses/courses.controller.ts": "",
    "src/courses/courses.service.ts": "",
    "src/courses/courses.module.ts": "",
    "prisma/schema.prisma": "model User { id Int @id }",
  });

  const profile = scanRepo(root);

  it("detects nestjs + prisma in stack", () => {
    expect(profile.stack).toContain("nestjs");
    expect(profile.stack).toContain("prisma");
  });

  it("entrypoints include controller/service/module patterns", () => {
    expect(profile.entrypoints).toContain("src/**/*.controller.ts");
    expect(profile.entrypoints).toContain("src/**/*.service.ts");
    expect(profile.entrypoints).toContain("src/**/*.module.ts");
  });

  it("CLAUDE.md takes priority for summary", () => {
    expect(profile.summary).toMatch(/app-api/);
    expect(profile.summary).toMatch(/NestJS/);
  });

  it("auth feature derived from CLAUDE.md mention", () => {
    expect(profile.features).toContain("auth");
  });

  rmSync(root, { recursive: true, force: true });
});

describe("scanRepo — keyword stopword filtering", () => {
  const root = mktmp("stopwords");
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "scratch",
      description: "the and of to a in for with on this that is are src lib app public dist build node_modules test tests spec course",
      dependencies: {},
    }),
  });

  const profile = scanRepo(root);

  it("strips common stopwords from keywords", () => {
    for (const sw of ["the", "and", "of", "src", "lib", "app", "test", "tests", "spec"]) {
      expect(profile.keywords).not.toContain(sw);
    }
    // domain word survives
    expect(profile.keywords).toContain("course");
  });

  it("caps keyword count at the documented max", () => {
    expect(profile.keywords.length).toBeLessThanOrEqual(__test.KEYWORD_CAP);
  });

  rmSync(root, { recursive: true, force: true });
});

describe("scanRepo — file count cap", () => {
  const root = mktmp("filecap");
  // Generate a wide tree of empty .ts files. We want ≥ FILE_WALK_CAP+1
  // entries so the cap is exercised. Bun/Node `mkdirSync` is fast enough.
  const target = __test.FILE_WALK_CAP + 50;
  const perDir = 200;
  let created = 0;
  let dirIdx = 0;
  while (created < target) {
    const dir = join(root, `pkg${dirIdx}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perDir && created < target; i++) {
      writeFileSync(join(dir, `f${i}.ts`), "");
      created += 1;
    }
    dirIdx += 1;
  }

  const profile = scanRepo(root);

  it("does not exceed the FILE_WALK_CAP for any extension count", () => {
    const total = Object.values(profile.fileCounts).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(__test.FILE_WALK_CAP);
  });

  rmSync(root, { recursive: true, force: true });
});

describe("suggestRepo — profile-aware classification", () => {
  const profiles = {
    "app-api": {
      name: "app-api",
      path: "/tmp/api",
      summary: "NestJS API",
      stack: ["nestjs", "prisma", "typescript"],
      keywords: ["course", "student", "enrollment"],
      features: ["auth", "lms"],
      entrypoints: [],
      fileCounts: {},
      refreshedAt: new Date().toISOString(),
      signals: {
        hasPackageJson: true,
        hasReadme: false,
        hasClaudeMd: false,
        hasNextConfig: false,
        hasPrismaSchema: true,
        hasTailwindConfig: false,
        hasNestCoreDep: true,
        hasReactDep: false,
        routerStyle: "src" as const,
        primaryLang: "ts" as const,
      },
    },
    "app-web": {
      name: "app-web",
      path: "/tmp/web",
      summary: "Next frontend",
      stack: ["next", "tailwindcss", "typescript"],
      keywords: ["dashboard", "course"],
      features: ["lms"],
      entrypoints: [],
      fileCounts: {},
      refreshedAt: new Date().toISOString(),
      signals: {
        hasPackageJson: true,
        hasReadme: false,
        hasClaudeMd: false,
        hasNextConfig: true,
        hasPrismaSchema: false,
        hasTailwindConfig: true,
        hasNestCoreDep: false,
        hasReactDep: true,
        routerStyle: "app" as const,
        primaryLang: "ts" as const,
      },
    },
  };
  const repos = ["app-web", "app-api"];

  it("classifies a backend-stacked repo and scores API prompts against it", () => {
    const out = suggestRepo(
      "Add an enrollment endpoint for the lms course catalog with auth.",
      repos,
      profiles,
    );
    expect(out.repo).toBe("app-api");
    expect(out.score).toBeGreaterThan(0);
    expect(out.reason).toMatch(/backend|feature|stack|profile/);
  });

  it("classifies a frontend-stacked repo and scores UI prompts against it", () => {
    const out = suggestRepo(
      "Build a tailwind dashboard component for the course list.",
      repos,
      profiles,
    );
    expect(out.repo).toBe("app-web");
    expect(out.score).toBeGreaterThan(0);
  });

  it("returns null when no profiles are supplied (no signal)", () => {
    const out = suggestRepo("Build a Tailwind component.", repos, undefined);
    expect(out.repo).toBeNull();
  });
});
