import { describe, expect, it } from "vitest";
import {
  extractModelsFromBundle,
  mergeModelChoices,
  parseModelAliasesFromHelp,
} from "../modelDiscovery";

// Verbatim from `claude --help` (2.1.x). The wrapping is the CLI's own.
const HELP = `
  --mcp-config <configs...>             Load MCP servers from JSON files
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

// Verbatim shapes lifted out of the shipped CLI bundle.
const BUNDLE = [
  `var p$n="Efficient for routine tasks",ePr="Best for everyday, complex tasks",`,
  `wEi="Fastest for quick answers",Xrc="Most capable for your hardest and longest-running tasks",TEi,Krc;`,
  `Krc={value:"haiku",label:"Haiku",description:\`Haiku 4.5 \\xB7 \${wEi}\`};`,
  `x={value:"opus",label:"Opus",description:\`Opus 4.8 \\xB7 \${ePr}\`};`,
  `y={value:"sonnet",label:"Sonnet",description:\`\${f_(id(fw()))??"Sonnet"} \\xB7 \${p$n}\`};`,
  `z={value:"high",label:"high",color:"permission"};`,
  `w={value:"opusplan",label:"Opus Plan Mode"};`,
].join("");

describe("parseModelAliasesFromHelp", () => {
  it("pulls the aliases the CLI documents for --model", () => {
    expect(parseModelAliasesFromHelp(HELP)).toEqual(["fable", "opus", "sonnet"]);
  });

  it("reads only the --model block, not --fallback-model or later flags", () => {
    const withNoise = HELP.replace(
      "overloaded",
      "overloaded (e.g. 'decoy-alias')",
    ).replace("Set a display name for this session", "Set 'another-decoy' name");
    expect(parseModelAliasesFromHelp(withNoise)).toEqual(["fable", "opus", "sonnet"]);
  });

  it("skips the full-name example, which is not an alias", () => {
    expect(parseModelAliasesFromHelp(HELP)).not.toContain("claude-fable-5");
  });

  it("returns an empty list when help text is missing or reshaped", () => {
    expect(parseModelAliasesFromHelp("")).toEqual([]);
    expect(parseModelAliasesFromHelp("--model <model>  Pick a model.")).toEqual([]);
  });
});

describe("extractModelsFromBundle", () => {
  it("finds the model entries with their labels", () => {
    const out = extractModelsFromBundle(BUNDLE);
    expect(out.map((m) => m.value)).toEqual(["haiku", "opus", "sonnet"]);
    expect(out.map((m) => m.label)).toEqual(["Haiku", "Opus", "Sonnet"]);
  });

  it("resolves the description constant the entry points at", () => {
    const out = extractModelsFromBundle(BUNDLE);
    expect(out.find((m) => m.value === "haiku")?.description)
      .toBe("Fastest for quick answers");
    expect(out.find((m) => m.value === "opus")?.description)
      .toBe("Best for everyday, complex tasks");
  });

  it("drops the version prefix, which the bundle reports staler than the live picker", () => {
    const out = extractModelsFromBundle(BUNDLE);
    for (const m of out) {
      expect(m.description ?? "").not.toMatch(/4\.5|4\.8/);
    }
  });

  it("recovers the blurb even when the version half is a runtime call", () => {
    // `${f_(id(fw()))??"Sonnet"} · ${p$n}` — dropping the version half leaves a
    // constant that resolves cleanly.
    const sonnet = extractModelsFromBundle(BUNDLE).find((m) => m.value === "sonnet");
    expect(sonnet?.description).toBe("Efficient for routine tasks");
  });

  it("leaves the description off when nothing resolvable survives", () => {
    const odd = `q={value:"mystery",label:"Mystery",description:\`\${zz(1)}\`};`;
    const out = extractModelsFromBundle(odd);
    expect(out.map((m) => m.value)).toEqual(["mystery"]);
    expect(out[0].description).toBeUndefined();
  });

  it("ignores the runtime suffixes appended after the blurb", () => {
    // Real shape: `Opus 4.8 · ${ePr}${HEi()}${t}` — a pricing suffix and a
    // disabled marker follow the constant.
    const withSuffix = [
      `var ePr="Best for everyday, complex tasks";`,
      `var o="schema is invalid:";`,
      `k={value:"opus",label:"Opus",description:\`\${n} \\xB7 \${ePr}\${o}\`};`,
    ].join("");
    expect(extractModelsFromBundle(withSuffix)[0].description)
      .toBe("Best for everyday, complex tasks");
  });

  it("never resolves a one or two letter name, which minified code reuses everywhere", () => {
    const collide = [
      `var o="schema is invalid:";`,
      `k={value:"opus",label:"Opus",description:\`X \\xB7 \${o}\`};`,
    ].join("");
    expect(extractModelsFromBundle(collide)[0].description).toBeUndefined();
  });

  it("ignores option lists that are not models", () => {
    const values = extractModelsFromBundle(BUNDLE).map((m) => m.value);
    expect(values).not.toContain("high"); // effort level
    expect(values).not.toContain("opusplan"); // a mode, and carries no description
  });

  it("prefers the variant that yields a blurb when a model appears more than once", () => {
    // The bundle carries several code paths per model; the first one in file
    // order is often a legacy branch whose description cannot be resolved.
    const many = [
      `var wEi="Fastest for quick answers";`,
      `a={value:"haiku",label:"Haiku",description:\`Haiku 3.5 for simple tasks\${nee("x",!1).pricingSuffix}\`};`,
      `b={value:"haiku",label:"Haiku",description:\`Haiku 4.5 \\xB7 \${wEi}\`};`,
    ].join("");
    const out = extractModelsFromBundle(many);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Fastest for quick answers");
  });

  it("returns nothing when the bundle shape changes, so the caller can fall back", () => {
    expect(extractModelsFromBundle("")).toEqual([]);
    expect(extractModelsFromBundle("no model literals here")).toEqual([]);
  });
});

describe("mergeModelChoices", () => {
  it("keeps the bundle's label and description, and adds help-only aliases", () => {
    const out = mergeModelChoices(
      ["fable", "opus", "sonnet"],
      extractModelsFromBundle(BUNDLE),
      [],
    );
    expect(out.map((c) => c.value)).toEqual(["haiku", "opus", "sonnet", "fable"]);
    expect(out.find((c) => c.value === "opus")?.description)
      .toBe("Best for everyday, complex tasks");
    // fable exists only in --help, so it has a label but no blurb
    const fable = out.find((c) => c.value === "fable");
    expect(fable?.label).toBe("Fable");
    expect(fable?.description).toBeUndefined();
  });

  it("appends model ids this machine has actually run", () => {
    const out = mergeModelChoices([], [], ["claude-opus-5"]);
    expect(out.map((c) => c.value)).toEqual(["claude-opus-5"]);
    expect(out[0].source).toBe("seen");
    expect(out[0].label).toBe("Claude Opus 5");
  });

  it("does not list a model twice across sources", () => {
    const out = mergeModelChoices(["opus"], extractModelsFromBundle(BUNDLE), ["opus"]);
    expect(out.filter((c) => c.value === "opus")).toHaveLength(1);
  });

  it("drops values --model would reject, so the picker cannot send junk", () => {
    const out = mergeModelChoices(["bad alias", "rm -rf /"], [], ["<synthetic>", ""]);
    expect(out).toEqual([]);
  });
});
