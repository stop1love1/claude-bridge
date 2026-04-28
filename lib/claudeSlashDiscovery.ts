import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, relative } from "node:path";

export type SlashDiscoverySource = "project" | "user";

export interface DiscoveredSlashCommand {
  slug: string;
  description: string | null;
  source: SlashDiscoverySource;
  /** Relative label for tooltip (paths are host-local). */
  relPath?: string;
}

const MAX_FILES = 800;
const MAX_DEPTH = 8;

function normSlug(raw: string): string {
  const s = raw.trim().replace(/^\/+/, "").replace(/\s+/g, "-");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*(?:\/[a-zA-Z0-9:_-]+)?$/.test(s)) return "";
  return s;
}

async function pathIsDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Parses fields from YAML frontmatter block at top of SKILL.md. */
function parseSkillYaml(content: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return {};
  const block = fm[1];
  const nameM = /^name:\s*(.+)$/m.exec(block);
  const descM = /^description:\s*(.+)$/m.exec(block);
  return {
    name: nameM ? normSlug(nameM[1].replace(/^["']|["']$/g, "")) : undefined,
    description: descM ? descM[1].slice(0, 240).trim() || undefined : undefined,
  };
}

async function* walkSkillMd(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  let count = 0;
  for (const e of entries) {
    if (count++ > MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkSkillMd(p, depth + 1);
    else if (e.isFile() && basename(p) === "SKILL.md") yield p;
  }
}

async function collectCommandsDir(
  cmdDir: string,
  source: SlashDiscoverySource,
  relPrefix: string,
): Promise<DiscoveredSlashCommand[]> {
  const out: DiscoveredSlashCommand[] = [];
  if (!(await pathIsDir(cmdDir))) return out;
  const entries = await readdir(cmdDir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(cmdDir, e.name);
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const slug = normSlug(basename(e.name, ".md"));
    if (!slug) continue;
    let desc: string | null = null;
    try {
      const raw = await readFile(p, "utf8");
      const body = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
      const line = body.split(/\r?\n/).find(Boolean);
      desc = line && line.length < 280 ? line : null;
    } catch {
      desc = null;
    }
    out.push({
      slug,
      description: desc,
      source,
      relPath: `${relPrefix}${e.name}`,
    });
  }
  return out;
}

async function collectSkillsDirs(
  skillsRoot: string,
  source: SlashDiscoverySource,
  repoRootForRelative: string,
): Promise<DiscoveredSlashCommand[]> {
  const home = homedir();
  const out: DiscoveredSlashCommand[] = [];
  if (!(await pathIsDir(skillsRoot))) return out;
  for await (const skillFile of walkSkillMd(skillsRoot)) {
    try {
      const raw = await readFile(skillFile, "utf8");
      const y = parseSkillYaml(raw);
      const slug = y.name ?? "";
      if (!slug) continue;
      let relPath: string;
      if (skillFile.startsWith(home)) {
        relPath =
          "~" + "/" + relative(home, skillFile).replace(/\\/g, "/");
      } else if (repoRootForRelative) {
        relPath = relative(repoRootForRelative, skillFile).replace(/\\/g, "/");
      } else {
        relPath = skillFile.replace(/\\/g, "/");
      }
      out.push({
        slug,
        description: y.description ?? null,
        source,
        relPath,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Slash definitions from `.claude/commands/*.md` and
 * `.claude/skills/<name>/SKILL.md` for the given repo (same discovery as Claude Code).
 * Later paths win on duplicate slug (skills override commands, same as Claude Code).
 */
export async function discoverProjectSlashCommands(
  repoRoot: string,
): Promise<DiscoveredSlashCommand[]> {
  const cmds = await collectCommandsDir(
    join(repoRoot, ".claude", "commands"),
    "project",
    ".claude/commands/",
  );
  const skills = await collectSkillsDirs(
    join(repoRoot, ".claude", "skills"),
    "project",
    repoRoot,
  );
  const merged = [...cmds, ...skills];
  const map = new Map<string, DiscoveredSlashCommand>();
  for (const c of merged) map.set(c.slug, c);
  return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Personal `~/.claude/commands` and `~/.claude/skills` (cross-project). */
export async function discoverUserSlashCommands(): Promise<DiscoveredSlashCommand[]> {
  const root = homedir();
  const base = join(root, ".claude");
  if (!(await pathIsDir(base))) return [];
  const cmds = await collectCommandsDir(join(base, "commands"), "user", "~/.claude/commands/");
  const skills = await collectSkillsDirs(join(base, "skills"), "user", "");
  const merged = [...cmds, ...skills];
  const seen = new Map<string, DiscoveredSlashCommand>();
  for (const c of merged) {
    if (!seen.has(c.slug)) seen.set(c.slug, c);
  }
  return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
