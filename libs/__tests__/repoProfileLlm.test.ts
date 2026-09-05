import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, type RepoProfile } from "../repoProfile";
import {
  applyProfileLLMResponse,
  buildProfileLLMArgs,
  buildProfileLLMPrompt,
  summarizeWithLLM,
} from "../repoProfileLlm";

const REQUIRED_DENIALS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Task"];

function mktmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bridge-profilellm-${label}-`));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(abs.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

function makeRepo(label: string): string {
  const root = mktmp(label);
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "shop-web",
      description: "Storefront",
      dependencies: { next: "^15.0.0", react: "^19.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "tsconfig.json": "{}",
    "README.md": "# shop-web\n\nStorefront for the shop.",
    "app/page.tsx": "export default function Page() { return null; }",
    "app/api/orders/route.ts": "export function GET() {}",
  });
  return root;
}

function fence(obj: unknown): string {
  return "Here you go:\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
}

describe("buildProfileLLMArgs", () => {
  it("denies every write and shell tool", () => {
    const args = buildProfileLLMArgs("profile this repo");
    expect(args).toContain("--disallowed-tools");
    for (const tool of REQUIRED_DENIALS) expect(args).toContain(tool);
  });

  it("places the prompt before --disallowed-tools so the variadic flag can't swallow it", () => {
    const args = buildProfileLLMArgs("profile this repo");
    const promptIdx = args.indexOf("profile this repo");
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeGreaterThan(promptIdx);
  });

  it("omits --model when no model is pinned", () => {
    expect(buildProfileLLMArgs("p")).not.toContain("--model");
  });

  it("passes a valid model through", () => {
    const args = buildProfileLLMArgs("p", "claude-opus-5");
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("claude-opus-5");
  });

  it("drops a model value that would land in argv as its own flag", () => {
    // isValidModel requires an alphanumeric first char precisely so a value
    // like this can never be smuggled into the child's argv.
    expect(buildProfileLLMArgs("p", "--dangerously-skip-permissions")).not.toContain("--model");
    expect(buildProfileLLMArgs("p", "")).not.toContain("--model");
  });
});

describe("buildProfileLLMPrompt", () => {
  const root = makeRepo("prompt");
  const profile = scanRepo(root);

  it("shows the heuristic profile and the entrypoint whitelist", () => {
    const prompt = buildProfileLLMPrompt(profile);
    expect(prompt).toContain(profile.name);
    expect(prompt).toContain(profile.summary);
    for (const ep of profile.entrypoints) expect(prompt).toContain(ep);
  });

  it("asks for one fenced JSON block with exactly the three contract keys", () => {
    const prompt = buildProfileLLMPrompt(profile);
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"features"');
    expect(prompt).toContain('"entrypoints"');
    expect(prompt).toContain("Do NOT add fields outside the schema");
  });
});

describe("applyProfileLLMResponse", () => {
  let profile: RepoProfile;
  beforeEach(() => {
    profile = scanRepo(makeRepo("apply"));
  });

  it("rewrites the summary, unions features and marks the source", () => {
    const out = applyProfileLLMResponse(
      fence({
        summary: "Next.js storefront that renders the catalogue and takes orders.",
        features: ["payments", "catalogue"],
        entrypoints: profile.entrypoints.slice(0, 1),
      }),
      profile,
    );
    expect(out).not.toBeNull();
    expect(out!.summary).toBe("Next.js storefront that renders the catalogue and takes orders.");
    expect(out!.features).toEqual(expect.arrayContaining([...profile.features, "catalogue"]));
    expect(out!.summarySource).toBe("llm");
  });

  it("drops entrypoints the heuristic scan never found", () => {
    const out = applyProfileLLMResponse(
      fence({
        summary: "A storefront.",
        features: [],
        entrypoints: ["totally/made/up/**/*.rb", ...profile.entrypoints.slice(0, 1)],
      }),
      profile,
    );
    expect(out!.entrypoints).toEqual(profile.entrypoints.slice(0, 1));
    expect(out!.entrypoints).not.toContain("totally/made/up/**/*.rb");
  });

  it("keeps the heuristic entrypoints when the model picks none of them", () => {
    const out = applyProfileLLMResponse(
      fence({ summary: "A storefront.", features: [], entrypoints: ["nope/**"] }),
      profile,
    );
    expect(out!.entrypoints).toEqual(profile.entrypoints);
  });

  it("drops feature labels that are not lowercase dot-namespaced", () => {
    const out = applyProfileLLMResponse(
      fence({
        summary: "A storefront.",
        features: ["Shop.Orders", "shop orders", "shop.orders", "", 42, "ci.pr-review"],
        entrypoints: [],
      }),
      profile,
    );
    expect(out!.features).toContain("shop.orders");
    expect(out!.features).toContain("ci.pr-review");
    expect(out!.features).not.toContain("Shop.Orders");
    expect(out!.features).not.toContain("shop orders");
  });

  it("ignores keys outside the contract", () => {
    const out = applyProfileLLMResponse(
      fence({
        summary: "A storefront.",
        features: [],
        entrypoints: [],
        stack: ["rails"],
        keywords: ["pwned"],
        path: "/etc/passwd",
      }),
      profile,
    );
    expect(out!.stack).toEqual(profile.stack);
    expect(out!.keywords).toEqual(profile.keywords);
    expect(out!.path).toBe(profile.path);
  });

  it("returns null on malformed JSON, on prose without JSON, and on a bare array", () => {
    expect(applyProfileLLMResponse("```json\n{ not json ,, }\n```", profile)).toBeNull();
    expect(applyProfileLLMResponse("I could not determine anything.", profile)).toBeNull();
    expect(applyProfileLLMResponse(fence(["a", "b"]), profile)).toBeNull();
  });

  it("returns null when the response changes nothing", () => {
    const out = applyProfileLLMResponse(
      fence({ summary: profile.summary, features: profile.features, entrypoints: profile.entrypoints }),
      profile,
    );
    expect(out).toBeNull();
  });
});

describe("summarizeWithLLM", () => {
  it("returns the heuristic profile untouched when the CLI cannot be spawned", async () => {
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = join(tmpdir(), "definitely-not-a-real-claude-binary");
    vi.resetModules();
    try {
      const mod = await import("../repoProfileLlm");
      const profile = scanRepo(makeRepo("spawnfail"));
      const out = await mod.summarizeWithLLM(profile);
      expect(out).toEqual(profile);
      expect(out.summarySource).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prev;
      vi.resetModules();
    }
  });

  it("returns the heuristic profile when the repo folder is gone", async () => {
    const root = makeRepo("missing");
    const profile = scanRepo(root);
    rmSync(root, { recursive: true, force: true });
    await expect(summarizeWithLLM(profile)).resolves.toEqual(profile);
  });
});

describe("profileStore wiring", () => {
  let stateDir: string;
  let repoRoot: string;

  beforeEach(() => {
    stateDir = mktmp("state");
    repoRoot = makeRepo("store");
  });

  afterEach(() => {
    vi.doUnmock("../paths");
    vi.doUnmock("../bridgeSettings");
    vi.doUnmock("../repoProfileLlm");
    vi.resetModules();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function loadStore(source: "heuristic" | "llm", llm: {
    summarizeWithLLM: (p: RepoProfile) => Promise<RepoProfile>;
  }) {
    vi.resetModules();
    vi.doMock("../paths", () => ({ BRIDGE_STATE_DIR: stateDir }));
    vi.doMock("../bridgeSettings", () => ({
      getManifestProfileSource: () => source,
    }));
    vi.doMock("../repoProfileLlm", () => llm);
    return import("../profileStore");
  }

  const neverCalled = {
    summarizeWithLLM: async () => {
      throw new Error("summarizeWithLLM must not be called");
    },
  };

  function readStoreFile(): { profiles: Record<string, RepoProfile> } {
    return JSON.parse(readFileSync(join(stateDir, "repo-profiles.json"), "utf8")) as {
      profiles: Record<string, RepoProfile>;
    };
  }

  it("heuristic (the default) never spawns the LLM and writes no summarySource key", async () => {
    const spy = vi.fn(async (p: RepoProfile) => p);
    const store = await loadStore("heuristic", { summarizeWithLLM: spy });
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    expect(spy).not.toHaveBeenCalled();
    const raw = readFileSync(join(stateDir, "repo-profiles.json"), "utf8");
    expect(raw).not.toContain("summarySource");
    expect(readStoreFile().profiles.shop.summarySource).toBeUndefined();
  });

  it("heuristic produces the same profile as the synchronous refreshAll", async () => {
    const store = await loadStore("heuristic", neverCalled);
    store.refreshAll([{ name: "shop", path: repoRoot }]);
    const sync = readStoreFile().profiles.shop;
    rmSync(join(stateDir, "repo-profiles.json"), { force: true });
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const enriched = readStoreFile().profiles.shop;
    expect({ ...enriched, refreshedAt: "" }).toEqual({ ...sync, refreshedAt: "" });
  });

  it("llm enrichment is applied and persisted", async () => {
    const store = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        features: [...p.features, "catalogue"],
        summarySource: "llm" as const,
      }),
    });
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const saved = readStoreFile().profiles.shop;
    expect(saved.summary).toBe("rewritten by the model");
    expect(saved.features).toContain("catalogue");
    expect(saved.summarySource).toBe("llm");
  });

  it("a throwing enricher still leaves a heuristic profile behind", async () => {
    const store = await loadStore("llm", {
      summarizeWithLLM: async () => {
        throw new Error("claude exited 1");
      },
    });
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const saved = readStoreFile().profiles.shop;
    expect(saved.summary).toContain("Storefront for the shop");
    expect(saved.summarySource).toBeUndefined();
    expect(saved.stack).toContain("next");
  });

  it("refreshOneEnriched honours the setting too", async () => {
    const spy = vi.fn(async (p: RepoProfile) => ({ ...p, summarySource: "llm" as const }));
    const store = await loadStore("llm", { summarizeWithLLM: spy });
    await store.refreshOneEnriched({ name: "shop", path: repoRoot });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readStoreFile().profiles.shop.summarySource).toBe("llm");
  });

  it("skips repos flagged as missing without calling the LLM", async () => {
    const spy = vi.fn(async (p: RepoProfile) => p);
    const store = await loadStore("llm", { summarizeWithLLM: spy });
    await store.refreshAllEnriched([{ name: "gone", path: repoRoot, exists: false }]);
    expect(spy).not.toHaveBeenCalled();
    expect(readStoreFile().profiles.gone).toBeUndefined();
  });

  it("enriches one repo at a time and stops once the wall-clock budget is spent", async () => {
    const second = makeRepo("store2");
    let inFlight = 0;
    const seen: string[] = [];
    const spy = vi.fn(async (p: RepoProfile) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      seen.push(p.path);
      // Burn the whole budget on the first repo.
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      inFlight -= 1;
      return { ...p, summarySource: "llm" as const };
    });
    const store = await loadStore("llm", { summarizeWithLLM: spy });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await store.refreshAllEnriched([
        { name: "a", path: repoRoot },
        { name: "b", path: second },
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(second, { recursive: true, force: true });
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([repoRoot]);
    const profiles = readStoreFile().profiles;
    expect(profiles.a.summarySource).toBe("llm");
    expect(profiles.b.summarySource).toBeUndefined();
  });
});
