import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

/**
 * `spawnCoordinatorForTask` orchestrates four concerns: read the
 * coordinator template, substitute structural placeholders + splice the
 * detected-scope block, sanitize user content, then hand the rendered
 * prompt to `spawnClaude`. We mock every I/O dependency so the test can
 * assert ordering — specifically that:
 *
 *   1. Structural placeholders (`{{SESSION_ID}}`, `{{TASK_ID}}`, etc.)
 *      are filled BEFORE user content (`{{TASK_BODY}}`), so a hostile
 *      task body containing a literal `{{SESSION_ID}}` is treated as
 *      data, not template.
 *   2. `## Detected scope` is spliced in AT the location of the
 *      `## Your job` marker — never before structural substitution and
 *      never after user content (which `sanitizeUserPromptContent`
 *      degrades the marker for, as belt-and-suspenders).
 *   3. When `readBridgeMd` returns "" (BRIDGE.md missing), the example
 *      repo falls back to BRIDGE_FOLDER instead of throwing.
 */

// `spawnClaude` is the exit point we capture — fake child + sessionId.
// Recorded calls are inspected per-test via the closure below.
const spawnCalls: Array<{ cwd: string; opts: unknown }> = [];

vi.mock("../spawn", () => ({
  spawnClaude: (cwd: string, opts: unknown) => {
    spawnCalls.push({ cwd, opts });
    // Minimal ChildProcess stub — `wireRunLifecycle` only attaches
    // `on("error", …)` / `on("exit", …)` listeners that never fire here.
    const child = {
      on: () => {
        /* noop */
      },
      once: () => {
        /* noop */
      },
    } as unknown as ChildProcess;
    return { child, sessionId: (opts as { sessionId?: string }).sessionId ?? "fake-sid" };
  },
}));

// Meta layer: succeed silently. The coordinator path calls
// readMeta (must not be null), appendRun, updateRun (queued→running).
const fakeMeta = {
  taskId: "t_20260424_001",
  taskTitle: "fake task",
  taskBody: "fake body",
  taskStatus: "todo",
  taskSection: "TODO",
  taskChecked: false,
  createdAt: "2026-04-24T00:00:00Z",
  runs: [],
};
vi.mock("../meta", () => ({
  readMeta: () => fakeMeta,
  appendRun: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue({ applied: true, run: null }),
}));

// runLifecycle.wireRunLifecycle is called after spawn — we don't care
// about its side effects here, only that it doesn't crash.
vi.mock("../runLifecycle", () => ({
  wireRunLifecycle: () => {
    /* noop */
  },
}));

// Profile store / repos / detect: return empty data so the scope block
// renders with the deterministic "_(detection layer crashed …)_" or
// "no detected" fallback. We control the renderDetectedScope output via
// a dedicated mock below.
vi.mock("../profileStore", () => ({
  loadProfiles: () => ({ profiles: [] }),
}));
vi.mock("../repos", () => ({
  resolveRepos: () => [],
}));
vi.mock("../detect", () => ({
  getOrComputeScope: vi.fn().mockResolvedValue({ repos: [] }),
  loadDetectInput: () => ({ taskBody: "", taskTitle: "", pinnedRepo: null }),
  renderDetectedScope: () => "## Detected scope\n\n_(test scope block)_\n",
}));

beforeEach(() => {
  spawnCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spawnCoordinatorForTask — prompt rendering", () => {
  it("substitutes structural placeholders before user content (task body containing {{SESSION_ID}} is data, not template)", async () => {
    const template = [
      "task=`{{TASK_ID}}` sid=`{{SESSION_ID}}` repo=`{{EXAMPLE_REPO}}` folder=`{{BRIDGE_FOLDER}}`",
      "",
      "## Your job",
      "",
      "title: {{TASK_TITLE}}",
      "body: {{TASK_BODY}}",
    ].join("\n");

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    // The body deliberately contains `{{SESSION_ID}}` and a `## Your job`
    // heading. After the substitution-then-splice flow, neither must
    // collide with the structural ones.
    const sid = await spawnCoordinatorForTask({
      id: "t_20260424_001",
      title: "title-x",
      body: "body has {{SESSION_ID}} in it and a ## Your job heading",
      app: null,
    });

    expect(sid).toBeTruthy();
    expect(spawnCalls).toHaveLength(1);
    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;

    // Structural placeholders are filled with real values.
    expect(prompt).toContain(`task=\`t_20260424_001\``);
    expect(prompt).toContain(`sid=\`${sid}\``);
    // The user-content `{{SESSION_ID}}` was sanitized to fullwidth
    // braces, so it stays literal — never interpolated.
    expect(prompt).toContain("｛｛SESSION_ID｝｝");
    // The body's heading was degraded (zero-width space after the
    // hashes) so the splice never landed there.
    expect(prompt).not.toMatch(/^## Your job heading/m);
  });

  it("splices the Detected scope block at the structural ## Your job marker", async () => {
    const template = [
      "header line",
      "",
      "## Your job",
      "",
      "rest of the template",
    ].join("\n");

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    await spawnCoordinatorForTask({
      id: "t_20260424_002",
      title: "t",
      body: "b",
      app: null,
    });

    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;
    // Scope appears between the header and the marker, exactly once.
    const scopeIdx = prompt.indexOf("## Detected scope");
    const jobIdx = prompt.indexOf("## Your job");
    expect(scopeIdx).toBeGreaterThan(0);
    expect(jobIdx).toBeGreaterThan(scopeIdx);
    expect(prompt.indexOf("header line")).toBeLessThan(scopeIdx);
  });

  it("falls back to BRIDGE_FOLDER for {{EXAMPLE_REPO}} when readBridgeMd throws", async () => {
    const template = "repo=`{{EXAMPLE_REPO}}` folder=`{{BRIDGE_FOLDER}}`\n## Your job\n";

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (p: string, enc?: BufferEncoding) => {
          if (typeof p === "string" && p.endsWith("coordinator.md")) return template;
          return actual.readFileSync(p, enc);
        },
      };
    });

    // Override `readBridgeMd` to throw so the try/catch in
    // `spawnCoordinatorForTask` exercises its fallback branch.
    vi.doMock("../paths", async () => {
      const actual = await vi.importActual<typeof import("../paths")>("../paths");
      return {
        ...actual,
        readBridgeMd: () => {
          throw new Error("synthetic BRIDGE.md read failure");
        },
      };
    });

    const { spawnCoordinatorForTask } = await import("../coordinator");
    const { BRIDGE_FOLDER } = await import("../paths");
    await spawnCoordinatorForTask({
      id: "t_20260424_003",
      title: "t",
      body: "b",
      app: null,
    });

    const prompt = (spawnCalls[0].opts as { prompt: string }).prompt;
    // Both markers fall back to the bridge folder name when the apps
    // registry can't be read — never to the unsubstituted literal.
    expect(prompt).toContain(`repo=\`${BRIDGE_FOLDER}\``);
    expect(prompt).toContain(`folder=\`${BRIDGE_FOLDER}\``);
    expect(prompt).not.toContain("{{EXAMPLE_REPO}}");
    expect(prompt).not.toContain("{{BRIDGE_FOLDER}}");
  });
});
