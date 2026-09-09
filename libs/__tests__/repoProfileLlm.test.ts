import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, type RepoProfile } from "../repoProfile";
import {
  __test,
  applyProfileLLMResponse,
  buildProfileLLMArgs,
  buildProfileLLMPrompt,
  summarizeWithLLM,
  type SummarizeResult,
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

describe("__test.sameList", () => {
  it("compares element by element, so a space in a path cannot fake equality", () => {
    // The reason this is not `a.join(" ") === b.join(" ")`: entrypoints are
    // paths, and a Windows path may contain a space.
    expect(__test.sameList(["a b", "c"], ["a", "b c"])).toBe(false);
    expect(__test.sameList(["a", "b"], ["b", "a"])).toBe(false);
    expect(__test.sameList(["a", "b"], ["a", "b"])).toBe(true);
    expect(__test.sameList([], [])).toBe(true);
    expect(__test.sameList(["a"], ["a", "b"])).toBe(false);
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

  it("counts a same-length reordering of entrypoints as a change", () => {
    // The model may only narrow or reorder the heuristic entrypoints, so a
    // reprioritised list of the same length is the one way "changed" can be
    // true while every array length stayed put. Comparing by count dropped the
    // whole enrichment — summarySource included — without a word.
    expect(profile.entrypoints.length).toBeGreaterThan(1);
    const reordered = [...profile.entrypoints].reverse();
    const out = applyProfileLLMResponse(
      fence({ summary: profile.summary, features: [], entrypoints: reordered }),
      profile,
    );
    expect(out).not.toBeNull();
    expect(out!.entrypoints).toEqual(reordered);
    expect(out!.summarySource).toBe("llm");
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
      expect(out.profile).toEqual(profile);
      expect(out.profile.summarySource).toBeUndefined();
      // A CLI that will not spawn is a failure, not a quiet agreement.
      expect(out.status).toBe("failed");
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
    await expect(summarizeWithLLM(profile)).resolves.toEqual({
      profile,
      status: "failed",
    });
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

  /**
   * Cases may hand back a bare profile (the common shape: "this is what the
   * model produced") or a full `SummarizeResult` when they care about the
   * difference between a pass that ran quietly and one that failed. A bare
   * profile is normalised the way the real function does it.
   */
  type LlmMock = {
    summarizeWithLLM: (p: RepoProfile) => Promise<RepoProfile | SummarizeResult>;
  };

  async function loadStore(
    source: "heuristic" | "llm" | (() => "heuristic" | "llm"),
    llm: LlmMock,
  ) {
    vi.resetModules();
    vi.doMock("../paths", () => ({ BRIDGE_STATE_DIR: stateDir }));
    vi.doMock("../bridgeSettings", () => ({
      getManifestProfileSource: () =>
        typeof source === "function" ? source() : source,
    }));
    vi.doMock("../repoProfileLlm", () => ({
      summarizeWithLLM: async (p: RepoProfile): Promise<SummarizeResult> => {
        const out = await llm.summarizeWithLLM(p);
        if ("status" in out) return out;
        return {
          profile: out,
          status: out.summarySource === "llm" ? "enriched" : "failed",
        };
      },
    }));
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

  // -- the TTL path must not eat an enrichment -------------------------------

  /** Rewrites the store's own timestamp so `ensureFreshOrAuto` sees it stale. */
  function ageStorePastTtl(): void {
    const path = join(stateDir, "repo-profiles.json");
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      refreshedAt: string;
      profiles: Record<string, RepoProfile>;
    };
    store.refreshedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(store), "utf8");
  }

  it("ensureFreshOrAuto past the TTL keeps an LLM summary and still re-scans the heuristics", async () => {
    const enriching = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        features: [...p.features, "catalogue"],
        entrypoints: ["app/page.tsx"],
        summarySource: "llm" as const,
      }),
    });
    await enriching.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const before = readStoreFile().profiles.shop;
    expect(before.summarySource).toBe("llm");

    ageStorePastTtl();
    // The repo grew a dependency the heuristic scan should pick up.
    writeFiles(repoRoot, {
      "package.json": JSON.stringify({
        name: "shop-web",
        description: "Storefront",
        dependencies: { next: "^15.0.0", react: "^19.0.0", "@prisma/client": "^5.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
      "prisma/schema.prisma": "model User { id Int @id }\n",
    });

    const auto = await loadStore("heuristic", neverCalled);
    auto.ensureFreshOrAuto([{ name: "shop", path: repoRoot }]);

    const after = readStoreFile().profiles.shop;
    expect(after.summarySource).toBe("llm");
    expect(after.summary).toBe("rewritten by the model");
    expect(after.features).toEqual(before.features);
    expect(after.entrypoints).toEqual(["app/page.tsx"]);
    // …but the heuristic half is genuinely fresh.
    expect(after.stack).toContain("prisma");
    expect(after.refreshedAt).not.toBe(before.refreshedAt);
  });

  it("a heuristic profile is still overwritten wholesale by a later scan", async () => {
    const store = await loadStore("heuristic", neverCalled);
    store.refreshAll([{ name: "shop", path: repoRoot }]);
    const fresh = readStoreFile().profiles.shop;

    // Same store, but the entry now looks like a stale heuristic profile.
    const path = join(stateDir, "repo-profiles.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      profiles: Record<string, RepoProfile>;
    };
    raw.profiles.shop = { ...fresh, summary: "stale heuristic guess", features: ["gone"] };
    writeFileSync(path, JSON.stringify(raw), "utf8");

    store.refreshAll([{ name: "shop", path: repoRoot }]);
    const after = readStoreFile().profiles.shop;
    expect(after.summary).toBe(fresh.summary);
    expect(after.features).toEqual(fresh.features);
  });

  // -- an LLM pass that was asked for and did not land ------------------------

  /** Seeds the store with one enriched profile and returns it. */
  async function seedEnriched(name = "shop", path = repoRoot): Promise<RepoProfile> {
    const enriching = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        features: [...p.features, "catalogue"],
        summarySource: "llm" as const,
      }),
    });
    await enriching.refreshAllEnriched([{ name, path }]);
    const seeded = readStoreFile().profiles[name];
    expect(seeded.summarySource).toBe("llm");
    return seeded;
  }

  it("keeps the previous summary when the LLM was asked and came back empty-handed", async () => {
    const before = await seedEnriched();
    // What a broken CLI actually looks like from here: summarizeWithLLM
    // swallows its own failure and hands the heuristic profile straight back.
    const failing = await loadStore("llm", { summarizeWithLLM: async (p: RepoProfile) => p });
    await failing.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const after = readStoreFile().profiles.shop;
    expect(after.summarySource).toBe("llm");
    expect(after.summary).toBe(before.summary);
    expect(after.features).toEqual(before.features);
  });

  it("keeps the previous summary when the enricher throws", async () => {
    const before = await seedEnriched();
    const throwing = await loadStore("llm", {
      summarizeWithLLM: async () => {
        throw new Error("claude exited 1");
      },
    });
    await throwing.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const after = readStoreFile().profiles.shop;
    expect(after.summarySource).toBe("llm");
    expect(after.summary).toBe(before.summary);
  });

  it("keeps the previous summary for repos the wall-clock budget never reached", async () => {
    const second = makeRepo("store2");
    const before = await seedEnriched("b", second);

    const spy = vi.fn(async (p: RepoProfile) => {
      // Burn the whole budget on the first repo, so "b" is never attempted.
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      return { ...p, summary: "fresh model text", summarySource: "llm" as const };
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
    const after = readStoreFile().profiles.b;
    expect(after.summarySource).toBe("llm");
    expect(after.summary).toBe(before.summary);
  });

  it("refreshOneEnriched keeps the previous summary on a failed pass too", async () => {
    const before = await seedEnriched();
    const failing = await loadStore("llm", { summarizeWithLLM: async (p: RepoProfile) => p });
    await failing.refreshOneEnriched({ name: "shop", path: repoRoot });
    expect(readStoreFile().profiles.shop.summary).toBe(before.summary);
  });

  it("an explicit refresh with the LLM turned off re-derives the profile from scratch", async () => {
    await seedEnriched();
    // The escape hatch: nobody asked for a pass, so the fresh scan wins.
    const plain = await loadStore("heuristic", neverCalled);
    await plain.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const after = readStoreFile().profiles.shop;
    expect(after.summarySource).toBeUndefined();
    expect(after.summary).not.toBe("rewritten by the model");
  });

  it("drops the enrichment when the app is repointed at a different directory", async () => {
    const before = await seedEnriched();
    const moved = makeRepo("moved");
    try {
      const store = await loadStore("heuristic", neverCalled);
      // Same name in bridge.json, different tree underneath.
      store.refreshAll([{ name: "shop", path: moved }]);
      const after = readStoreFile().profiles.shop;
      expect(after.path).toBe(moved);
      expect(after.summarySource).toBeUndefined();
      expect(after.summary).not.toBe(before.summary);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it("survives a hand-edited entry that claims summarySource llm but has no arrays", async () => {
    const store = await loadStore("heuristic", neverCalled);
    store.refreshAll([{ name: "shop", path: repoRoot }]);
    const fresh = readStoreFile().profiles.shop;

    const path = join(stateDir, "repo-profiles.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    // `fresh.path` rather than `repoRoot`: the scan normalises the path it is
    // handed, and the enrichment guard compares it verbatim.
    raw.profiles.shop = { path: fresh.path, summary: "hand written", summarySource: "llm" };
    writeFileSync(path, JSON.stringify(raw), "utf8");

    expect(() => store.refreshAll([{ name: "shop", path: repoRoot }])).not.toThrow();
    const after = readStoreFile().profiles.shop;
    expect(after.features).toEqual(fresh.features);
    expect(after.summary).toBe(fresh.summary);
  });

  // -- how old is the enrichment, really -------------------------------------

  it("stamps enrichedAt when a pass lands, and a heuristic re-scan does not touch it", async () => {
    const enriching = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        summarySource: "llm" as const,
      }),
    });
    await enriching.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const enriched = readStoreFile().profiles.shop;
    expect(enriched.enrichedAt).toBeTruthy();

    // A heuristic re-scan later: refreshedAt moves, enrichedAt must not — that
    // gap is the only way to see that the LLM summary is a day stale.
    await new Promise((r) => setTimeout(r, 5));
    const plain = await loadStore("heuristic", neverCalled);
    plain.refreshAll([{ name: "shop", path: repoRoot }]);
    const after = readStoreFile().profiles.shop;
    expect(after.enrichedAt).toBe(enriched.enrichedAt);
    expect(after.refreshedAt).not.toBe(enriched.refreshedAt);
  });

  it("a working pass that agrees with the heuristic refreshes the age but keeps the summary", async () => {
    const enriching = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        summarySource: "llm" as const,
      }),
    });
    await enriching.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const before = readStoreFile().profiles.shop;

    await new Promise((r) => setTimeout(r, 5));
    // The CLI ran fine; the model just had nothing to add this time. That is
    // not an outage, so the enrichment is as current as it can be.
    const quiet = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({ profile: p, status: "unchanged" as const }),
    });
    await quiet.refreshAllEnriched([{ name: "shop", path: repoRoot }]);

    const after = readStoreFile().profiles.shop;
    expect(after.summary).toBe(before.summary);
    expect(after.summarySource).toBe("llm");
    expect(after.enrichedAt).not.toBe(before.enrichedAt);
  });

  it("a failed pass leaves the age alone, so a broken CLI cannot fake freshness", async () => {
    const enriching = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({
        ...p,
        summary: "rewritten by the model",
        summarySource: "llm" as const,
      }),
    });
    await enriching.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const before = readStoreFile().profiles.shop;

    await new Promise((r) => setTimeout(r, 5));
    const broken = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({ profile: p, status: "failed" as const }),
    });
    await broken.refreshAllEnriched([{ name: "shop", path: repoRoot }]);

    const after = readStoreFile().profiles.shop;
    expect(after.summary).toBe(before.summary);
    expect(after.enrichedAt).toBe(before.enrichedAt);
  });

  it("leaves no enrichedAt behind when a quiet pass runs on a never-enriched repo", async () => {
    const quiet = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => ({ profile: p, status: "unchanged" as const }),
    });
    await quiet.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const saved = readStoreFile().profiles.shop;
    // The summary is still the heuristic one, so dating it as an LLM summary
    // would be a lie.
    expect(saved.summarySource).toBeUndefined();
    expect(saved.enrichedAt ?? null).toBeNull();
  });

  // -- one refresh, one setting ----------------------------------------------

  it("holds profiles.source for the whole pass when the operator flips it mid-refresh", async () => {
    const second = makeRepo("store2");
    try {
      // Seed both repos with an enrichment worth losing.
      const seed = await loadStore("llm", {
        summarizeWithLLM: async (p: RepoProfile) => ({
          ...p,
          summary: `model text for ${p.name}`,
          summarySource: "llm" as const,
        }),
      });
      await seed.refreshAllEnriched([
        { name: "a", path: repoRoot },
        { name: "b", path: second },
      ]);
      expect(readStoreFile().profiles.b.summarySource).toBe("llm");

      // Now the operator switches the toggle to `heuristic` while repo "a" is
      // still being enriched. Before the fix, repo "b" was then treated as
      // "nobody asked" and its enrichment was written straight over.
      let live: "heuristic" | "llm" = "llm";
      const store = await loadStore(() => live, {
        summarizeWithLLM: async (p: RepoProfile) => {
          live = "heuristic";
          return { ...p, summary: "fresh model text", summarySource: "llm" as const };
        },
      });
      await store.refreshAllEnriched([
        { name: "a", path: repoRoot },
        { name: "b", path: second },
      ]);

      // The whole pass ran under the setting it started with, so "b" was
      // enriched like "a". Reading the setting per repo instead made "b" look
      // like "nobody asked for an LLM pass", which writes its fresh heuristic
      // scan straight over the enrichment: summarySource would be undefined.
      expect(readStoreFile().profiles.b.summarySource).toBe("llm");
      expect(readStoreFile().profiles.b.summary).toBe("fresh model text");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  // -- two clicks on "Refresh now" -------------------------------------------

  it("shares one pass between overlapping refreshAllEnriched calls", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => {
        calls += 1;
        await gate;
        return { ...p, summary: "model text", summarySource: "llm" as const };
      },
    });

    const first = store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    const second = store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    release();
    const [a, b] = await Promise.all([first, second]);

    // One pass, one result object — not two passes racing to write the store.
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(readStoreFile().profiles.shop.summarySource).toBe("llm");
  });

  it("lets a later refresh run once the first one has finished", async () => {
    let calls = 0;
    const store = await loadStore("llm", {
      summarizeWithLLM: async (p: RepoProfile) => {
        calls += 1;
        return { ...p, summary: `pass ${calls}`, summarySource: "llm" as const };
      },
    });
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    await store.refreshAllEnriched([{ name: "shop", path: repoRoot }]);
    expect(calls).toBe(2);
    expect(readStoreFile().profiles.shop.summary).toBe("pass 2");
  });
});
