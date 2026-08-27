
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const DIFF_CAP_BYTES = 16 * 1024;

export interface NameStatusLine {
  status: "A" | "D" | "M" | "R" | "T" | "C";
  path: string;
  oldPath?: string;
}

export function parseNameStatus(out: string): NameStatusLine[] {
  const rows: NameStatusLine[] = [];
  for (const ln of out.split("\n")) {
    if (!ln.trim()) continue;
    const parts = ln.split("\t");
    const head = parts[0] ?? "";
    if (head.startsWith("R") && parts.length >= 3) {
      rows.push({ status: "R", oldPath: parts[1], path: parts[2] });
      continue;
    }
    const status = head[0];
    if (
      status === "A" || status === "D" || status === "M" ||
      status === "T" || status === "C"
    ) {
      rows.push({ status: status as NameStatusLine["status"], path: parts[1] ?? "" });
    }
  }
  return rows;
}

const GENERIC_TOPS = new Set([
  "src", "app", "lib", "libs", "components", "pkg", "internal",
  "packages", "modules", "module",
]);

export function deriveScope(paths: string[]): string {
  if (paths.length === 0) return "";
  const splits = paths.map((p) => p.split("/"));
  const minLen = Math.min(...splits.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const seg = splits[0][i];
    if (splits.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  while (common.length > 0 && GENERIC_TOPS.has(common[0])) common.shift();
  if (common.length === 0) return "";
  return common.slice(-1)[0] ?? "";
}

const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const TEST_HINTS = ["__tests__", ".test.", ".spec."];

function classify(rows: NameStatusLine[]): { type: string; verb: string } {
  let added = 0, removed = 0, modified = 0, renamed = 0, docs = 0, tests = 0;
  for (const r of rows) {
    if (r.status === "A") added++;
    else if (r.status === "D") removed++;
    else if (r.status === "M") modified++;
    else if (r.status === "R") renamed++;
    const ext = (r.path.match(/\.([^./]+)$/)?.[1] ?? "").toLowerCase();
    if (DOC_EXTS.has(ext)) docs++;
    if (TEST_HINTS.some((h) => r.path.includes(h))) tests++;
  }
  const total = rows.length;
  let type = "chore";
  if (total > 0 && docs / total >= 0.8) type = "docs";
  else if (total > 0 && tests / total >= 0.8) type = "test";
  else if (added > modified + renamed && removed === 0) type = "feat";
  else if (removed > added) type = "refactor";
  else if (modified > 0) type = "fix";
  const verb =
    added > 0 && modified === 0 && removed === 0 && renamed === 0 ? "add"
    : removed > 0 && added === 0 && modified === 0 && renamed === 0 ? "remove"
    : renamed > 0 && added === 0 && removed === 0 ? "rename"
    : "update";
  return { type, verb };
}

export function buildHeuristicMessage(rows: NameStatusLine[]): string {
  if (rows.length === 0) return "chore: no changes";
  const scope = deriveScope(rows.map((r) => r.path));
  const { type, verb } = classify(rows);
  const fileWord = rows.length === 1 ? "file" : "files";
  const focus = rows.length === 1
    ? rows[0].path.split("/").slice(-1)[0]
    : `${rows.length} ${fileWord}`;
  const title = scope ? `${type}(${scope}): ${verb} ${focus}` : `${type}: ${verb} ${focus}`;
  const CAP = 8;
  const shown = rows.slice(0, CAP);
  const overflow = rows.length - shown.length;
  const bullets = shown.map((r) => {
    if (r.status === "R" && r.oldPath) return `- rename ${r.oldPath} → ${r.path}`;
    const v =
      r.status === "A" ? "add"
      : r.status === "D" ? "remove"
      : r.status === "M" ? "update"
      : r.status === "T" ? "change mode of"
      : r.status === "C" ? "copy to" : "touch";
    return `- ${v} ${r.path}`;
  });
  if (overflow > 0) bullets.push(`- …and ${overflow} more`);
  return `${title}\n\n${bullets.join("\n")}`;
}

function renderNameStatus(rows: NameStatusLine[]): string {
  return rows
    .map((r) => {
      if (r.status === "R" && r.oldPath) return `R  ${r.oldPath} -> ${r.path}`;
      const tag =
        r.status === "A" ? "A " :
        r.status === "D" ? "D " :
        r.status === "M" ? "M " :
        r.status === "T" ? "T " :
        r.status === "C" ? "C " : "? ";
      return `${tag} ${r.path}`;
    })
    .join("\n");
}

export interface CollectedChanges {
  rows: NameStatusLine[];
  nameStatus: string;
  diff: string;
  diffTruncated: boolean;
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const res = await execFileP("git", args, {
    cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  return res.stdout.toString();
}

export async function collectChanges(
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<CollectedChanges> {
  const [headNS, wtNS, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-status", "-M", "HEAD"], timeoutMs).catch(() => ""),
    git(cwd, ["diff", "--name-status", "-M"], timeoutMs),
    git(cwd, ["ls-files", "--others", "--exclude-standard"], timeoutMs),
  ]);

  const seen = new Set<string>();
  const rows: NameStatusLine[] = [];
  for (const line of [...parseNameStatus(headNS), ...parseNameStatus(wtNS)]) {
    if (seen.has(line.path)) continue;
    seen.add(line.path);
    rows.push(line);
  }
  for (const path of untracked.split("\n")) {
    const p = path.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    rows.push({ status: "A", path: p });
  }

  let diff = "";
  let diffTruncated = false;
  if (rows.length > 0) {
    const raw = await git(cwd, ["diff", "-M", "HEAD"], timeoutMs).catch(() => "");
    if (raw.length > DIFF_CAP_BYTES) {
      diff = raw.slice(0, DIFF_CAP_BYTES);
      diffTruncated = true;
    } else {
      diff = raw;
    }
  }

  return { rows, nameStatus: renderNameStatus(rows), diff, diffTruncated };
}
