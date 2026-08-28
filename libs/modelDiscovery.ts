import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * The model list is discovered at runtime rather than hardcoded: the CLI
 * publishes the aliases its own `--model` flag accepts, and the user's
 * transcripts name the model ids they have actually run. Both move on their
 * own — a Claude Code update or a new model showing up in a session — and
 * neither needs an API key, which matters because subscription auth has none.
 */

export type ModelSource = "cli" | "seen";

export interface ModelChoice {
  value: string;
  label: string;
  description?: string;
  source: ModelSource;
}

export interface ExtractedModel {
  value: string;
  label: string;
  description?: string;
}

/** Same shape `libs/spawn.ts` requires before it will pass --model through. */
const MODEL_VALUE_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Reads the aliases out of the `--model` entry of `claude --help`, e.g.
 *   --model <model>   Model for the current session. Provide
 *                     an alias for the latest model (e.g.
 *                     'fable', 'opus', or 'sonnet') or a
 *                     model's full name (e.g. 'claude-fable-5').
 * Only the alias example is taken; the full-name example is deliberately left
 * out, since pinning a dated id is what this is trying to avoid.
 */
export function parseModelAliasesFromHelp(help: string): string[] {
  if (!help) return [];
  const start = help.indexOf("--model <model>");
  if (start === -1) return [];
  // The flag's block ends where the next flag begins.
  const rest = help.slice(start + "--model <model>".length);
  const nextFlag = rest.search(/\n\s{2,}-{1,2}[A-Za-z]/);
  const block = nextFlag === -1 ? rest : rest.slice(0, nextFlag);

  const aliasIntro = block.search(/alias for the latest model/i);
  if (aliasIntro === -1) return [];
  // Stop before the "full name" example so `claude-fable-5` is not offered.
  const fullName = block.search(/full name/i);
  const aliasPart = fullName === -1 ? block.slice(aliasIntro) : block.slice(aliasIntro, fullName);

  const out: string[] = [];
  for (const m of aliasPart.matchAll(/'([^']+)'/g)) {
    const v = m[1].trim();
    if (MODEL_VALUE_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** `opus` -> Opus; `claude-opus-5` -> Claude Opus 5. */
function titleize(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/**
 * Resolves one entry's description template against the bundle's string
 * constants. The version half (`Haiku 4.5 · …`) is dropped on purpose: the
 * shipped bundle reports it staler than the picker a running CLI draws, so it
 * is the one part that would display something untrue.
 */
function resolveDescription(
  template: string,
  constants: Map<string, string>,
): string | undefined {
  const sep = template.search(/\\xB7|·/);
  const tail = (sep === -1 ? template : template.slice(sep).replace(/^(\\xB7|·)/, "")).trim();
  if (!tail) return undefined;

  // Take the first interpolation that names a module constant and stop there.
  // What follows is runtime garnish (pricing suffix, "(disabled)" marker), and
  // names shorter than three characters are minifier locals reused across the
  // whole bundle — resolving those splices in unrelated strings.
  for (const m of tail.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]{2,})\}/g)) {
    const v = constants.get(m[1]);
    if (v !== undefined && v.trim()) return v.trim();
  }
  // A plain literal with no interpolation at all is usable as-is.
  if (!tail.includes("${")) return tail;
  return undefined;
}

/**
 * Pulls `{value,label,description}` model entries out of the shipped CLI
 * bundle. Requiring a `description:` key is what separates models from the
 * effort levels and prompt choices that share the value/label shape.
 */
export function extractModelsFromBundle(text: string): ExtractedModel[] {
  if (!text) return [];

  const constants = new Map<string, string>();
  for (const m of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)="([^"\\]{4,160})"/g)) {
    if (!constants.has(m[1])) constants.set(m[1], m[2]);
  }

  const out: ExtractedModel[] = [];
  const re = /\{value:"([a-z0-9-]{2,30})",label:"([^"]{1,40})",description:`([^`]*)`/g;
  for (const m of text.matchAll(re)) {
    const value = m[1];
    if (!MODEL_VALUE_RE.test(value)) continue;
    const description = resolveDescription(m[3], constants);
    const existing = out.find((e) => e.value === value);
    if (existing) {
      // A model appears in several code paths; the earliest is often a legacy
      // branch whose description does not resolve. Take the one that does.
      if (existing.description === undefined && description !== undefined) {
        existing.description = description;
        existing.label = m[2];
      }
      continue;
    }
    const entry: ExtractedModel = { value, label: m[2] };
    if (description !== undefined) entry.description = description;
    out.push(entry);
  }
  return out;
}

/** Bundle entries first (they carry labels), then help-only aliases, then ids seen locally. */
export function mergeModelChoices(
  aliases: string[],
  fromBundle: ExtractedModel[],
  seen: string[],
): ModelChoice[] {
  const out: ModelChoice[] = [];
  const push = (entry: ModelChoice) => {
    if (!MODEL_VALUE_RE.test(entry.value)) return;
    if (out.some((c) => c.value === entry.value)) return;
    out.push(entry);
  };
  for (const e of fromBundle) {
    push({ value: e.value, label: e.label, ...(e.description ? { description: e.description } : {}), source: "cli" });
  }
  for (const a of aliases) {
    push({ value: (a ?? "").trim(), label: titleize((a ?? "").trim()), source: "cli" });
  }
  for (const s of seen) {
    push({ value: (s ?? "").trim(), label: titleize((s ?? "").trim()), source: "seen" });
  }
  return out;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { value: ModelChoice[]; expires: number } | null = null;

function readCliHelp(): string {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  try {
    const r = spawnSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      // Windows needs a shell to resolve the `claude.cmd` shim; the args are a
      // constant, so there is nothing to inject.
      shell: process.platform === "win32",
    });
    return r.status === 0 ? (r.stdout ?? "") : "";
  } catch {
    return "";
  }
}

function resolveCliPath(): string | null {
  const explicit = process.env.CLAUDE_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 3000, windowsHide: true })
      : spawnSync("which", ["claude"], { encoding: "utf8", timeout: 3000 });
  if (probe.status !== 0 || !probe.stdout) return null;
  const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first && existsSync(first) ? first : null;
}

const BUNDLE_CHUNK = 8 * 1024 * 1024;
const BUNDLE_OVERLAP = 4096;

/**
 * Scans the CLI for its model entries. The binary is a few hundred MB, so it is
 * read in chunks with an overlap wide enough that no entry can be split across
 * a boundary.
 */
function readModelsFromCliBinary(): ExtractedModel[] {
  const path = resolveCliPath();
  if (!path) return [];
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(BUNDLE_CHUNK);
    const found: ExtractedModel[] = [];
    let carry = "";
    for (let pos = 0; pos < size; pos += BUNDLE_CHUNK) {
      const read = readSync(fd, buf, 0, Math.min(BUNDLE_CHUNK, size - pos), pos);
      if (read <= 0) break;
      const text = carry + buf.toString("latin1", 0, read);
      for (const e of extractModelsFromBundle(text)) {
        const existing = found.find((f) => f.value === e.value);
        if (!existing) {
          found.push(e);
        } else if (existing.description === undefined && e.description !== undefined) {
          existing.description = e.description;
          existing.label = e.label;
        }
      }
      carry = text.slice(-BUNDLE_OVERLAP);
    }
    return found;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { }
    }
  }
}

export function discoverModels(seen: string[] = []): ModelChoice[] {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  const value = mergeModelChoices(
    parseModelAliasesFromHelp(readCliHelp()),
    readModelsFromCliBinary(),
    seen,
  );
  cache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

export function _resetModelCacheForTests(): void {
  cache = null;
}
