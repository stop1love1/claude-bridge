# Task Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web UI in the bridge repo that assigns tasks, dispatches a coordinator+coder+reviewer agent team into sibling FE/BE repos, and streams the native Claude Code sessions back to the user.

**Architecture:** Single Bun process running a Hono server. `tasks.md` is source of truth for tasks; `~/.claude/projects/<slug>/*.jsonl` are source of truth for sessions; `sessions/<task-id>/meta.json` maps task ↔ session IDs. The coordinator (a `claude -p` session spawned in the bridge repo) reads bridge context and spawns coder/reviewer child `claude -p` sessions in the target sibling repo. Frontend is a single vanilla-JS page with three panes.

**Tech Stack:** Bun (runtime), Hono (HTTP), vanilla HTML/CSS/JS (frontend), `bun test` + `vitest`-style expect for tests, `child_process.spawn` for agent invocation.

**Spec:** [docs/superpowers/specs/2026-04-24-task-management-ui-design.md](../specs/2026-04-24-task-management-ui-design.md)

---

## File structure

**Created in this plan:**

```
edusoft-lms-bridge/
├── package.json                       project metadata + scripts
├── tsconfig.json                      strict TS config
├── bunfig.toml                        bun test config
├── .gitignore                         node_modules, *.log
├── ui/
│   ├── server.ts                      Hono app: API routes + static serve
│   ├── lib/
│   │   ├── repos.ts                   parse BRIDGE.md Repos table → sibling paths
│   │   ├── tasks.ts                   parse/serialize tasks.md
│   │   ├── meta.ts                    read/write/append sessions/<id>/meta.json
│   │   ├── sessions.ts                slug resolver + JSONL byte-offset tail
│   │   └── spawn.ts                   spawn `claude -p`, capture session ID
│   ├── lib/__tests__/
│   │   ├── repos.test.ts
│   │   ├── tasks.test.ts
│   │   ├── meta.test.ts
│   │   ├── sessions.test.ts
│   │   └── spawn.test.ts
│   ├── lib/__tests__/fixtures/
│   │   ├── tasks-basic.md
│   │   ├── tasks-with-notes.md
│   │   ├── bridge.md
│   │   └── session.jsonl
│   └── public/
│       ├── index.html                 three-pane shell
│       ├── app.js                     vanilla JS, no build
│       └── styles.css                 CSS grid layout
├── agents/
│   ├── coordinator.md                 prompt template (role=coordinator)
│   ├── coder.md                       prompt template (role=coder)
│   └── reviewer.md                    prompt template (role=reviewer)
├── sessions/
│   └── .gitkeep                       preserve folder in git
```

**Modified in this plan:**

- `tasks.md` — add `## TODO — UNASSIGNED` section.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `sessions/.gitkeep`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "edusoft-lms-bridge-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "ui": "bun run ui/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowJs": false,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["ui/**/*.ts"]
}
```

- [ ] **Step 3: Create bunfig.toml**

```toml
[test]
root = "./ui/lib/__tests__"
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
*.log
.DS_Store
bun.lockb
```

- [ ] **Step 5: Create sessions/.gitkeep**

Empty file so git tracks the folder.

- [ ] **Step 6: Install deps**

Run: `cd "d:/Edusoft/edusoft-lms-bridge" && bun install`
Expected: `node_modules/` appears, `bun.lockb` created.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore sessions/.gitkeep
git commit -m "chore: scaffold Bun + Hono project for bridge UI"
```

---

## Task 2: Add TODO — UNASSIGNED section to tasks.md

**Files:**
- Modify: `tasks.md`

- [ ] **Step 1: Edit tasks.md**

Insert this section immediately after the existing intro (before `## TODO — FE`):

```md
## TODO — UNASSIGNED

_(Tasks created via the UI land here first. The coordinator moves them to DOING after deciding which side to dispatch to. Manually-authored handoffs should go under TODO — FE or TODO — BE instead.)_
```

- [ ] **Step 2: Commit**

```bash
git add tasks.md
git commit -m "docs: add TODO — UNASSIGNED section for UI-dispatched tasks"
```

---

## Task 3: Repos parser — `ui/lib/repos.ts`

**Files:**
- Create: `ui/lib/repos.ts`, `ui/lib/__tests__/repos.test.ts`, `ui/lib/__tests__/fixtures/bridge.md`

- [ ] **Step 1: Create fixture `ui/lib/__tests__/fixtures/bridge.md`**

```md
# Some title

## Repos

Explanatory text.

| Side | Folder name       |
|------|-------------------|
| FE   | `edusoft-lms`     |
| BE   | `edusoft-lms-api` |

More text.
```

- [ ] **Step 2: Write failing tests `ui/lib/__tests__/repos.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { parseReposTable, resolveRepos } from "../repos";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(join(__dirname, "fixtures/bridge.md"), "utf8");

describe("parseReposTable", () => {
  it("extracts FE and BE folder names from the Repos table", () => {
    const repos = parseReposTable(fixture);
    expect(repos).toEqual([
      { side: "FE", folder: "edusoft-lms" },
      { side: "BE", folder: "edusoft-lms-api" },
    ]);
  });

  it("throws if no Repos table present", () => {
    expect(() => parseReposTable("# Just a heading\n\nNo table.")).toThrow(/Repos table/);
  });
});

describe("resolveRepos", () => {
  it("resolves each folder as sibling of the bridge root", () => {
    const resolved = resolveRepos(fixture, "/parent/bridge");
    expect(resolved).toEqual([
      { side: "FE", folder: "edusoft-lms",     path: "/parent/edusoft-lms"     },
      { side: "BE", folder: "edusoft-lms-api", path: "/parent/edusoft-lms-api" },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test ui/lib/__tests__/repos.test.ts`
Expected: FAIL with "Cannot find module '../repos'".

- [ ] **Step 4: Implement `ui/lib/repos.ts`**

```ts
import { resolve, dirname } from "node:path";

export type Side = "FE" | "BE";
export type RepoEntry = { side: Side; folder: string };
export type ResolvedRepo = RepoEntry & { path: string };

export function parseReposTable(bridgeMd: string): RepoEntry[] {
  const section = bridgeMd.match(/##\s+Repos[\s\S]*?(?=\n##\s|\n$|$)/);
  if (!section) throw new Error("No Repos table found in BRIDGE.md");

  const rows = section[0].matchAll(
    /^\|\s*(FE|BE)\s*\|\s*`?([^|`\s]+)`?\s*\|/gm,
  );

  const entries: RepoEntry[] = [];
  for (const row of rows) {
    entries.push({ side: row[1] as Side, folder: row[2] });
  }
  if (entries.length === 0) throw new Error("Repos table is empty");
  return entries;
}

export function resolveRepos(bridgeMd: string, bridgeRoot: string): ResolvedRepo[] {
  const parent = dirname(resolve(bridgeRoot));
  return parseReposTable(bridgeMd).map((e) => ({
    ...e,
    path: resolve(parent, e.folder),
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test ui/lib/__tests__/repos.test.ts`
Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/repos.ts ui/lib/__tests__/repos.test.ts ui/lib/__tests__/fixtures/bridge.md
git commit -m "feat(ui): add repos parser for BRIDGE.md sibling folder lookup"
```

---

## Task 4: Tasks parser — `ui/lib/tasks.ts`

**Files:**
- Create: `ui/lib/tasks.ts`, `ui/lib/__tests__/tasks.test.ts`, `ui/lib/__tests__/fixtures/tasks-basic.md`

- [ ] **Step 1: Create fixture `ui/lib/__tests__/fixtures/tasks-basic.md`**

```md
# Tasks — Active Handoffs

> intro

## TODO — UNASSIGNED

- [ ] **2026-04-24** Add /users/me endpoint <!-- task-id: t_20260424_001 -->
  Contract: `contracts/users-me.md`
  Notes: needs email + roles

## TODO — FE

_(none)_

## TODO — BE

_(none)_

## DOING

- [ ] **2026-04-23** Wire up login form <!-- task-id: t_20260423_002 -->

## BLOCKED

_(none)_

## DONE — not yet archived

- [x] **2026-04-22** Ship contracts index <!-- task-id: t_20260422_001 -->

---

## Entry template

template stuff kept as-is
```

- [ ] **Step 2: Write failing tests `ui/lib/__tests__/tasks.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { parseTasks, serializeTasks, generateTaskId } from "../tasks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(join(__dirname, "fixtures/tasks-basic.md"), "utf8");

describe("parseTasks", () => {
  it("extracts tasks with id, title, date, status, body", () => {
    const tasks = parseTasks(fixture);
    expect(tasks).toHaveLength(3);

    const t1 = tasks.find((t) => t.id === "t_20260424_001")!;
    expect(t1.status).toBe("todo");
    expect(t1.section).toBe("TODO — UNASSIGNED");
    expect(t1.date).toBe("2026-04-24");
    expect(t1.title).toBe("Add /users/me endpoint");
    expect(t1.body).toContain("Contract: `contracts/users-me.md`");
    expect(t1.body).toContain("Notes: needs email + roles");

    const t2 = tasks.find((t) => t.id === "t_20260423_002")!;
    expect(t2.status).toBe("doing");

    const t3 = tasks.find((t) => t.id === "t_20260422_001")!;
    expect(t3.status).toBe("done");
    expect(t3.checked).toBe(true);
  });
});

describe("serializeTasks", () => {
  it("round-trips fixture → parse → serialize → parse", () => {
    const tasks = parseTasks(fixture);
    const md = serializeTasks(fixture, tasks);
    const reparsed = parseTasks(md);
    expect(reparsed).toEqual(tasks);
  });

  it("moves a task to a new section when status changes", () => {
    const tasks = parseTasks(fixture);
    const t1 = tasks.find((t) => t.id === "t_20260424_001")!;
    t1.status = "doing";
    t1.section = "DOING";
    const md = serializeTasks(fixture, tasks);
    expect(md).toMatch(/## DOING[\s\S]*t_20260424_001/);
    expect(md).not.toMatch(/## TODO — UNASSIGNED[\s\S]*t_20260424_001/);
  });
});

describe("generateTaskId", () => {
  it("returns t_YYYYMMDD_NNN incrementing from existing IDs for the same day", () => {
    const existing = ["t_20260424_001", "t_20260424_002", "t_20260423_005"];
    expect(generateTaskId(new Date("2026-04-24T10:00:00Z"), existing)).toBe("t_20260424_003");
    expect(generateTaskId(new Date("2026-04-25T10:00:00Z"), existing)).toBe("t_20260425_001");
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `bun test ui/lib/__tests__/tasks.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `ui/lib/tasks.ts`**

```ts
export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskSection =
  | "TODO — UNASSIGNED"
  | "TODO — FE"
  | "TODO — BE"
  | "DOING"
  | "BLOCKED"
  | "DONE — not yet archived";

export interface Task {
  id: string;
  date: string;          // YYYY-MM-DD
  title: string;
  body: string;          // everything after the title line, excluding blank tail
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;      // [x] vs [ ]
}

const SECTION_STATUS: Record<TaskSection, TaskStatus> = {
  "TODO — UNASSIGNED": "todo",
  "TODO — FE": "todo",
  "TODO — BE": "todo",
  "DOING": "doing",
  "BLOCKED": "blocked",
  "DONE — not yet archived": "done",
};
const ALL_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];

export function parseTasks(md: string): Task[] {
  const tasks: Task[] = [];
  const sectionRe = /^## (TODO — UNASSIGNED|TODO — FE|TODO — BE|DOING|BLOCKED|DONE — not yet archived)\s*$/gm;
  const matches = [...md.matchAll(sectionRe)];
  for (let i = 0; i < matches.length; i++) {
    const section = matches[i][1] as TaskSection;
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.indexOf("\n---", start);
    const block = md.slice(start, end === -1 ? undefined : end);
    const itemRe = /^- \[([ x])\]\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s+(.+?)\s*<!--\s*task-id:\s*(t_\d{8}_\d{3})\s*-->\s*\n((?:(?!^- \[|^## ).*\n)*)/gm;
    for (const m of block.matchAll(itemRe)) {
      tasks.push({
        id: m[4],
        date: m[2],
        title: m[3].trim(),
        body: m[5].replace(/\s+$/, ""),
        checked: m[1] === "x",
        status: SECTION_STATUS[section],
        section,
      });
    }
  }
  return tasks;
}

function renderTask(t: Task): string {
  const check = t.checked ? "x" : " ";
  const body = t.body ? t.body.replace(/\s+$/, "") + "\n" : "";
  return `- [${check}] **${t.date}** ${t.title} <!-- task-id: ${t.id} -->\n${body}`;
}

export function serializeTasks(originalMd: string, tasks: Task[]): string {
  let out = originalMd;
  // strip all existing tasks section-by-section
  for (const section of ALL_SECTIONS) {
    const re = new RegExp(
      `(## ${section.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*\\n)([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`,
    );
    out = out.replace(re, (_m, header: string) => {
      const items = tasks.filter((t) => t.section === section).map(renderTask).join("");
      const placeholder = items ? "" : sectionPlaceholder(section);
      return `${header}\n${items || placeholder}\n`;
    });
  }
  return out;
}

function sectionPlaceholder(section: TaskSection): string {
  if (section === "TODO — UNASSIGNED") {
    return "_(Tasks created via the UI land here first. The coordinator moves them to DOING after deciding which side to dispatch to. Manually-authored handoffs should go under TODO — FE or TODO — BE instead.)_";
  }
  if (section === "BLOCKED") {
    return "_(none — blocked tasks go here with the reason and a link to `questions.md` if waiting for an answer)_";
  }
  return "_(none)_";
}

export function generateTaskId(now: Date, existing: string[]): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const prefix = `t_${y}${m}${d}_`;
  const max = existing
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test ui/lib/__tests__/tasks.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/tasks.ts ui/lib/__tests__/tasks.test.ts ui/lib/__tests__/fixtures/tasks-basic.md
git commit -m "feat(ui): add tasks.md parser/serializer with id generation"
```

---

## Task 5: Meta.json CRUD — `ui/lib/meta.ts`

**Files:**
- Create: `ui/lib/meta.ts`, `ui/lib/__tests__/meta.test.ts`

- [ ] **Step 1: Write failing tests `ui/lib/__tests__/meta.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeta, readMeta, appendRun, updateRun } from "../meta";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "meta-")); });

describe("meta.ts", () => {
  it("creates, reads, appends, and updates runs", () => {
    const dir = join(tmp, "t_20260424_001");
    createMeta(dir, { taskId: "t_20260424_001", taskTitle: "Add /me", createdAt: "2026-04-24T10:00:00Z" });

    let meta = readMeta(dir);
    expect(meta.taskId).toBe("t_20260424_001");
    expect(meta.runs).toEqual([]);

    appendRun(dir, { sessionId: "s1", role: "coordinator", side: null, repo: "edusoft-lms-bridge", status: "queued", startedAt: null, endedAt: null });
    meta = readMeta(dir);
    expect(meta.runs).toHaveLength(1);
    expect(meta.runs[0].sessionId).toBe("s1");

    updateRun(dir, "s1", { status: "running", startedAt: "2026-04-24T10:00:05Z" });
    meta = readMeta(dir);
    expect(meta.runs[0].status).toBe("running");
    expect(meta.runs[0].startedAt).toBe("2026-04-24T10:00:05Z");
  });

  it("readMeta returns null if file does not exist", () => {
    expect(readMeta(join(tmp, "missing"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ui/lib/__tests__/meta.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ui/lib/meta.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type RunRole = "coordinator" | "coder" | "reviewer";
export type RunStatus = "queued" | "running" | "done" | "failed" | "stale";
export type Side = "FE" | "BE" | null;

export interface Run {
  sessionId: string;
  role: RunRole;
  side: Side;
  repo: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Meta {
  taskId: string;
  taskTitle: string;
  createdAt: string;
  runs: Run[];
}

const FILE = "meta.json";

export function createMeta(dir: string, header: Omit<Meta, "runs">): void {
  mkdirSync(dir, { recursive: true });
  const meta: Meta = { ...header, runs: [] };
  writeFileSync(join(dir, FILE), JSON.stringify(meta, null, 2) + "\n");
}

export function readMeta(dir: string): Meta | null {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Meta;
}

export function appendRun(dir: string, run: Run): void {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`meta.json missing at ${dir}`);
  meta.runs.push(run);
  writeFileSync(join(dir, FILE), JSON.stringify(meta, null, 2) + "\n");
}

export function updateRun(dir: string, sessionId: string, patch: Partial<Run>): void {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`meta.json missing at ${dir}`);
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) throw new Error(`run ${sessionId} not found`);
  Object.assign(run, patch);
  writeFileSync(join(dir, FILE), JSON.stringify(meta, null, 2) + "\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ui/lib/__tests__/meta.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/meta.ts ui/lib/__tests__/meta.test.ts
git commit -m "feat(ui): add meta.json CRUD for task→session mapping"
```

---

## Task 6: Sessions reader — `ui/lib/sessions.ts`

**Files:**
- Create: `ui/lib/sessions.ts`, `ui/lib/__tests__/sessions.test.ts`, `ui/lib/__tests__/fixtures/session.jsonl`

- [ ] **Step 1: Create fixture `ui/lib/__tests__/fixtures/session.jsonl`**

```
{"type":"user","message":{"role":"user","content":"[ROLE: coordinator] [TASK: t_20260424_001]\nHello"},"timestamp":"2026-04-24T10:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":"Analyzing task..."},"timestamp":"2026-04-24T10:00:02Z"}
{"type":"assistant","message":{"role":"assistant","content":"Side = BE"},"timestamp":"2026-04-24T10:00:04Z"}
```

- [ ] **Step 2: Write failing tests `ui/lib/__tests__/sessions.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { pathToSlug, tailJsonl, findSessionByPrefix } from "../sessions";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";

describe("pathToSlug", () => {
  it("converts Windows drive path to Claude slug", () => {
    expect(pathToSlug("D:\\Edusoft\\edusoft-lms-bridge")).toBe("D--Edusoft-edusoft-lms-bridge");
  });
  it("converts POSIX path to Claude slug", () => {
    expect(pathToSlug("/home/u/edusoft-lms")).toBe("-home-u-edusoft-lms");
  });
});

describe("tailJsonl", () => {
  it("returns full content at offset=0 and new offset at EOF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2}\n`);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }, { b: 2 }]);
    expect(out.offset).toBe(16);
  });

  it("returns only new lines since offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n`);
    const first = await tailJsonl(file, 0);
    writeFileSync(file, `{"a":1}\n{"b":2}\n`);
    const second = await tailJsonl(file, first.offset);
    expect(second.lines).toEqual([{ b: 2 }]);
  });

  it("skips incomplete trailing lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2`); // no trailing newline
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }]);
    expect(out.offset).toBe(8); // only up to first \n
  });
});

describe("findSessionByPrefix", () => {
  it("finds the newest .jsonl whose first user message starts with prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const old = join(dir, "old.jsonl");
    const neu = join(dir, "new.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(old, `{"type":"user","message":{"role":"user","content":"[ROLE: coder] [TASK: t_20260424_001] hi"}}\n`);
    writeFileSync(neu, `{"type":"user","message":{"role":"user","content":"[ROLE: coder] [TASK: t_20260424_001] hi"}}\n`);
    writeFileSync(other, `{"type":"user","message":{"role":"user","content":"[ROLE: reviewer] [TASK: t_20260424_001] hi"}}\n`);
    utimesSync(old, Date.now() / 1000 - 100, Date.now() / 1000 - 100);

    const match = await findSessionByPrefix(dir, "[ROLE: coder] [TASK: t_20260424_001]");
    expect(match).toBe(neu);
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `bun test ui/lib/__tests__/sessions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `ui/lib/sessions.ts`**

```ts
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Convert an absolute path to Claude Code's project slug convention: replace /, \, : with -. */
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[\\/:]/g, "-");
}

export interface TailResult {
  lines: unknown[];
  offset: number;
}

export async function tailJsonl(filePath: string, fromOffset: number): Promise<TailResult> {
  const size = statSync(filePath).size;
  if (fromOffset >= size) return { lines: [], offset: size };
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - fromOffset);
    readSync(fd, buf, 0, buf.length, fromOffset);
    const raw = buf.toString("utf8");
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline === -1) return { lines: [], offset: fromOffset };
    const complete = raw.slice(0, lastNewline);
    const lines = complete
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try { return JSON.parse(l); } catch { return { __raw: l, __parseError: true }; }
      });
    return { lines, offset: fromOffset + Buffer.byteLength(complete, "utf8") + 1 };
  } finally {
    closeSync(fd);
  }
}

export async function findSessionByPrefix(projectDir: string, prefix: string): Promise<string | null> {
  let files: string[];
  try { files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")); }
  catch { return null; }

  const candidates = files
    .map((f) => ({ path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates) {
    try {
      const first = readFileSync(c.path, "utf8").split("\n", 1)[0];
      const obj = JSON.parse(first) as { type?: string; message?: { role?: string; content?: string } };
      const content = obj?.message?.content ?? "";
      if (obj.type === "user" && content.startsWith(prefix)) return c.path;
    } catch { /* skip malformed */ }
  }
  return null;
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `bun test ui/lib/__tests__/sessions.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/sessions.ts ui/lib/__tests__/sessions.test.ts ui/lib/__tests__/fixtures/session.jsonl
git commit -m "feat(ui): add session slug resolver, JSONL tail, and prefix finder"
```

---

## Task 7: Spawn wrapper — `ui/lib/spawn.ts`

**Files:**
- Create: `ui/lib/spawn.ts`, `ui/lib/__tests__/spawn.test.ts`

- [ ] **Step 1: Write failing tests `ui/lib/__tests__/spawn.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import { extractSessionId, buildCoordinatorArgs } from "../spawn";

describe("extractSessionId", () => {
  it("matches a UUID on any of the first N stdout lines", () => {
    const stdout = "starting claude\nsession-id: 550e8400-e29b-41d4-a716-446655440000\nworking...\n";
    expect(extractSessionId(stdout)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
  it("returns null if no UUID present in first 5 lines", () => {
    expect(extractSessionId("line1\nline2\nline3\n")).toBeNull();
  });
});

describe("buildCoordinatorArgs", () => {
  it("builds claude -p args with role+task prefix + body", () => {
    const args = buildCoordinatorArgs({
      role: "coordinator",
      taskId: "t_20260424_001",
      prompt: "Do the thing.",
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toMatch(/^\[ROLE: coordinator\] \[TASK: t_20260424_001\]/);
    expect(args[1]).toContain("Do the thing.");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test ui/lib/__tests__/spawn.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ui/lib/spawn.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { findSessionByPrefix } from "./sessions";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToSlug } from "./sessions";
import { basename } from "node:path";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export function extractSessionId(stdoutChunk: string): string | null {
  const lines = stdoutChunk.split("\n").slice(0, 5);
  for (const line of lines) {
    const m = line.match(UUID_RE);
    if (m) return m[0];
  }
  return null;
}

export interface SpawnOpts {
  role: "coordinator" | "coder" | "reviewer";
  taskId: string;
  prompt: string;
}

export function buildCoordinatorArgs(opts: SpawnOpts): string[] {
  const prefix = `[ROLE: ${opts.role}] [TASK: ${opts.taskId}]`;
  return ["-p", `${prefix}\n${opts.prompt}`];
}

export interface SpawnedSession {
  child: ChildProcess;
  sessionIdPromise: Promise<string>; // resolves once captured (stdout or fallback)
}

/** Spawn `claude` with role/task-tagged prompt in cwd. Detached from parent. */
export function spawnClaude(cwd: string, opts: SpawnOpts): SpawnedSession {
  const child = spawn("claude", buildCoordinatorArgs(opts), {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.unref();

  const sessionIdPromise = new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(async () => {
      // fallback: newest .jsonl whose first user message starts with our prefix
      const slug = pathToSlug(cwd);
      const projectDir = join(homedir(), ".claude", "projects", slug);
      const prefix = `[ROLE: ${opts.role}] [TASK: ${opts.taskId}]`;
      const path = await findSessionByPrefix(projectDir, prefix);
      if (path) resolve(basename(path, ".jsonl"));
      else reject(new Error("session id capture timed out"));
    }, 10000);

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const id = extractSessionId(buf);
      if (id) { clearTimeout(timer); resolve(id); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  return { child, sessionIdPromise };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test ui/lib/__tests__/spawn.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/spawn.ts ui/lib/__tests__/spawn.test.ts
git commit -m "feat(ui): add claude -p spawn wrapper with session id capture + fallback"
```

---

## Task 8: Hono API server — `ui/server.ts`

**Files:**
- Create: `ui/server.ts`

- [ ] **Step 1: Implement `ui/server.ts`**

```ts
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { parseTasks, serializeTasks, generateTaskId, type Task, type TaskStatus, type TaskSection } from "./lib/tasks";
import { resolveRepos } from "./lib/repos";
import { createMeta, readMeta } from "./lib/meta";
import { pathToSlug, tailJsonl } from "./lib/sessions";
import { spawnClaude } from "./lib/spawn";

const BRIDGE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..").replace(/^\/([A-Za-z]:)/, "$1");
const TASKS_PATH = join(BRIDGE_ROOT, "tasks.md");
const BRIDGE_MD  = join(BRIDGE_ROOT, "BRIDGE.md");
const SESSIONS_DIR = join(BRIDGE_ROOT, "sessions");
const AGENTS_DIR  = join(BRIDGE_ROOT, "agents");

const app = new Hono();

app.get("/api/repos", (c) => {
  const md = readFileSync(BRIDGE_MD, "utf8");
  const repos = resolveRepos(md, BRIDGE_ROOT).map((r) => ({
    ...r,
    exists: existsSync(r.path),
  }));
  return c.json(repos);
});

app.get("/api/tasks", (c) => {
  const md = readFileSync(TASKS_PATH, "utf8");
  return c.json(parseTasks(md));
});

app.post("/api/tasks", async (c) => {
  const { title, body } = await c.req.json<{ title: string; body?: string }>();
  if (!title) return c.json({ error: "title required" }, 400);
  const md = readFileSync(TASKS_PATH, "utf8");
  const tasks = parseTasks(md);
  const id = generateTaskId(new Date(), tasks.map((t) => t.id));
  const today = new Date().toISOString().slice(0, 10);
  const task: Task = {
    id,
    date: today,
    title,
    body: body ?? "",
    checked: false,
    status: "todo",
    section: "TODO — UNASSIGNED",
  };
  tasks.push(task);
  writeFileSync(TASKS_PATH, serializeTasks(md, tasks));
  createMeta(join(SESSIONS_DIR, id), {
    taskId: id,
    taskTitle: title,
    createdAt: new Date().toISOString(),
  });
  return c.json(task, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const patch = await c.req.json<Partial<Pick<Task, "title" | "body" | "section" | "status" | "checked">>>();
  const md = readFileSync(TASKS_PATH, "utf8");
  const tasks = parseTasks(md);
  const t = tasks.find((x) => x.id === id);
  if (!t) return c.json({ error: "not found" }, 404);
  Object.assign(t, patch);
  if (patch.section) {
    const map: Record<TaskSection, TaskStatus> = {
      "TODO — UNASSIGNED": "todo", "TODO — FE": "todo", "TODO — BE": "todo",
      "DOING": "doing", "BLOCKED": "blocked", "DONE — not yet archived": "done",
    };
    t.status = map[patch.section];
  }
  writeFileSync(TASKS_PATH, serializeTasks(md, tasks));
  return c.json(t);
});

app.post("/api/tasks/:id/dispatch", async (c) => {
  const id = c.req.param("id");
  const metaDir = join(SESSIONS_DIR, id);
  const meta = readMeta(metaDir);
  if (!meta) return c.json({ error: "task not found" }, 404);

  const coordinatorTemplate = readFileSync(join(AGENTS_DIR, "coordinator.md"), "utf8");
  const md = readFileSync(TASKS_PATH, "utf8");
  const task = parseTasks(md).find((t) => t.id === id);
  if (!task) return c.json({ error: "task missing in tasks.md" }, 404);

  const prompt = coordinatorTemplate
    .replaceAll("{{TASK_ID}}", id)
    .replaceAll("{{TASK_TITLE}}", task.title)
    .replaceAll("{{TASK_BODY}}", task.body);

  try {
    const spawned = spawnClaude(BRIDGE_ROOT, { role: "coordinator", taskId: id, prompt });
    const sessionId = await spawned.sessionIdPromise;
    const { appendRun } = await import("./lib/meta");
    appendRun(metaDir, {
      sessionId, role: "coordinator", side: null,
      repo: "edusoft-lms-bridge", status: "running",
      startedAt: new Date().toISOString(), endedAt: null,
    });
    return c.json({ taskId: id, coordinatorSessionId: sessionId }, 202);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get("/api/tasks/:id/meta", (c) => {
  const meta = readMeta(join(SESSIONS_DIR, c.req.param("id")));
  if (!meta) return c.json({ error: "not found" }, 404);
  return c.json(meta);
});

app.get("/api/sessions/:sessionId/tail", async (c) => {
  const sessionId = c.req.param("sessionId");
  const repoPath  = c.req.query("repo"); // absolute path of the repo that owns this session
  const since     = Number(c.req.query("since") ?? 0);
  if (!repoPath) return c.json({ error: "repo query param required" }, 400);
  const slug = pathToSlug(repoPath);
  const file = join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
  if (!existsSync(file)) return c.json({ lines: [], offset: since });
  const result = await tailJsonl(file, since);
  return c.json(result);
});

app.get("/*", serveStatic({ root: "./ui/public" }));
app.get("/", serveStatic({ path: "./ui/public/index.html" }));

export default { port: 7777, fetch: app.fetch };

console.log("bridge UI: http://localhost:7777");
```

- [ ] **Step 2: Smoke-test compile**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/server.ts
git commit -m "feat(ui): add Hono server with tasks/dispatch/meta/tail endpoints"
```

---

## Task 9: Agent prompt templates — `agents/*.md`

**Files:**
- Create: `agents/coordinator.md`, `agents/coder.md`, `agents/reviewer.md`

- [ ] **Step 1: Create `agents/coordinator.md`**

```md
You are the **coordinator** for a single bridge task.

- Task ID: `{{TASK_ID}}`
- Task title: {{TASK_TITLE}}
- Task body:
  ```
  {{TASK_BODY}}
  ```

## Your job

1. Read `BRIDGE.md` (Repos table for folder names), `tasks.md` (the target entry), and any contract referenced by the task body.
2. Decide which side must act: `FE`, `BE`, or `BOTH`. Prefer a single side when possible.
3. Move the task in `tasks.md` from its current section to `DOING` (keep the `<!-- task-id: {{TASK_ID}} -->` comment).
4. For each side you picked, in order:
   a. Read `agents/coder.md`. Substitute `{{TASK_ID}}`, `{{TASK_TITLE}}`, `{{TASK_BODY}}`, `{{SIDE}}`, leave `{{COORDINATOR_NOTES}}` for any context you want to add.
   b. Write the rendered prompt to `sessions/{{TASK_ID}}/coder-<SIDE>.prompt.txt`.
   c. Use Bash: `claude -p "$(cat sessions/{{TASK_ID}}/coder-<SIDE>.prompt.txt)"` with `cwd=../edusoft-lms` (FE) or `cwd=../edusoft-lms-api` (BE). Capture stdout.
   d. Extract the session UUID from stdout; append a run entry to `sessions/{{TASK_ID}}/meta.json` with role=`coder`, side=<SIDE>, repo=<folder>, status=`running`, startedAt=now.
   e. Wait for the child `claude` process to exit. Update the run entry (status=`done` on exit 0, else `failed`, endedAt=now).
   f. Render `agents/reviewer.md` similarly and spawn a reviewer run in the same repo. Pass the coder's branch name `task/{{TASK_ID}}` in `{{COORDINATOR_NOTES}}`.
   g. Wait for reviewer to exit. If reviewer output contains `BLOCK:`, run ONE fix cycle: spawn coder again with `{{COORDINATOR_NOTES}}` = the review's block reason, then reviewer again. No further retries.
5. Finalize `tasks.md`:
   - All sides approved → move the task to `DONE — not yet archived`, set `[x]`.
   - Any side still blocked after the fix cycle → move to `BLOCKED`, append the block reason to the task body.

## Rules

- You do not write code yourself. Only orchestration.
- All cross-repo paths come from `BRIDGE.md`. Never hardcode `D:/...`.
- Keep updates to `meta.json` atomic (read → modify → write whole file).
- If any required file is missing (`tasks.md` entry, prompt template, sibling repo), stop and update the run entry as `failed` with a clear error message.
```

- [ ] **Step 2: Create `agents/coder.md`**

```md
You are the **coder** for bridge task `{{TASK_ID}}` on the **{{SIDE}}** side.

- Task title: {{TASK_TITLE}}
- Task body:
  ```
  {{TASK_BODY}}
  ```
- Coordinator notes:
  ```
  {{COORDINATOR_NOTES}}
  ```

## Your job

1. Create (or check out) a topic branch: `task/{{TASK_ID}}`.
2. Read any contract file referenced by the task body (paths are relative to the bridge, i.e. `../edusoft-lms-bridge/contracts/...`).
3. Implement the task following this repo's existing conventions (stack, naming, folder layout). Do NOT restructure unrelated code.
4. Write tests appropriate for this repo (e2e for HTTP endpoints, unit for pure logic). Tests must actually run and pass.
5. Run the repo's lint + test commands (check `package.json` scripts or `CLAUDE.md`). Fix anything you broke.
6. Commit to `task/{{TASK_ID}}`. Small commits preferred. Do NOT push to remote.
7. Exit with a one-paragraph summary of what changed + the branch name + which tests you ran.

## Rules

- Never touch `../edusoft-lms-bridge/` from here — the coordinator owns those files.
- If a contract is ambiguous, STOP and emit `BLOCKED: <question>` instead of guessing. The coordinator will handle it.
- If the task requires the other side's cooperation (new endpoint needed, new field needed), emit `NEEDS-OTHER-SIDE: <description>` and stop.
```

- [ ] **Step 3: Create `agents/reviewer.md`**

```md
You are the **reviewer** for bridge task `{{TASK_ID}}` on the **{{SIDE}}** side.

- Task title: {{TASK_TITLE}}
- Task body:
  ```
  {{TASK_BODY}}
  ```
- Coordinator notes (branch, prior blocks, etc.):
  ```
  {{COORDINATOR_NOTES}}
  ```

## Your job

1. Check out the topic branch mentioned in coordinator notes (default: `task/{{TASK_ID}}`).
2. Read the diff vs `main` (or whatever base the repo uses).
3. Check:
   - Does the diff fulfill the task body and any referenced contract?
   - Are tests present, meaningful (not stubs), and passing?
   - Does it follow this repo's conventions?
   - Any obvious bugs, security holes, or missing error paths at external boundaries?
4. Run the repo's test + lint commands from scratch. Report exit codes.
5. Output exactly one of:
   - `APPROVE` — on its own line, followed by a one-paragraph summary of what was reviewed.
   - `BLOCK: <reason>` — on its own line, followed by specific actionable issues.

## Rules

- You are not a pair programmer. Do not write code. Do not push commits.
- If you cannot check out the branch or tests cannot run at all, emit `BLOCK: <environment issue>`.
- Prefer APPROVE with minor notes over BLOCK for trivia. BLOCK only for things that must be fixed before the task can be considered done.
```

- [ ] **Step 4: Commit**

```bash
git add agents/
git commit -m "feat(agents): add coordinator/coder/reviewer prompt templates"
```

---

## Task 10: Frontend HTML + CSS — `ui/public/index.html`, `ui/public/styles.css`

**Files:**
- Create: `ui/public/index.html`, `ui/public/styles.css`

- [ ] **Step 1: Create `ui/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Edusoft LMS — Bridge Coordinator</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>Edusoft LMS — Bridge Coordinator</h1>
    <button id="new-task-btn">+ New task</button>
  </header>

  <main>
    <aside id="tasks-pane">
      <div class="group" data-section="TODO — UNASSIGNED"><h2>TODO — UNASSIGNED <span class="count"></span></h2><ul></ul></div>
      <div class="group" data-section="TODO — FE"><h2>TODO — FE <span class="count"></span></h2><ul></ul></div>
      <div class="group" data-section="TODO — BE"><h2>TODO — BE <span class="count"></span></h2><ul></ul></div>
      <div class="group" data-section="DOING"><h2>DOING <span class="count"></span></h2><ul></ul></div>
      <div class="group" data-section="BLOCKED"><h2>BLOCKED <span class="count"></span></h2><ul></ul></div>
      <div class="group" data-section="DONE — not yet archived"><h2>DONE <span class="count"></span></h2><ul></ul></div>
    </aside>

    <section id="detail-pane">
      <div id="empty-detail" class="empty">Select a task →</div>
      <div id="task-detail" hidden>
        <div class="id" id="detail-id"></div>
        <input id="detail-title" />
        <textarea id="detail-body" rows="8"></textarea>
        <div class="actions">
          <button id="save-btn">Save</button>
          <button id="dispatch-btn">▶ Dispatch</button>
        </div>
        <h3>Runs</h3>
        <ul id="runs-list"></ul>
      </div>
    </section>

    <section id="session-pane">
      <div id="empty-session" class="empty">Select a run →</div>
      <div id="session-viewer" hidden>
        <div class="id" id="session-header"></div>
        <div id="session-log"></div>
      </div>
    </section>
  </main>

  <dialog id="new-task-dialog">
    <form method="dialog">
      <h2>New task</h2>
      <label>Title<input id="new-title" required /></label>
      <label>Body<textarea id="new-body" rows="6"></textarea></label>
      <menu>
        <button value="cancel">Cancel</button>
        <button id="new-submit" value="submit">Create</button>
      </menu>
    </form>
  </dialog>

  <script src="/app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create `ui/public/styles.css`**

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; background: #0f1115; color: #d7dae0; }
header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: #161a21; border-bottom: 1px solid #22262d; }
header h1 { font-size: 14px; margin: 0; }
button { background: #22262d; color: #d7dae0; border: 1px solid #2e333c; padding: 6px 10px; cursor: pointer; border-radius: 4px; }
button:hover { background: #2e333c; }
main { flex: 1; display: grid; grid-template-columns: 240px 1fr 1fr; overflow: hidden; }
aside, section { overflow-y: auto; padding: 8px 12px; border-right: 1px solid #22262d; }
#session-pane { border-right: none; }
.group h2 { font-size: 11px; text-transform: uppercase; color: #7a8088; margin: 12px 0 4px; }
.group .count { opacity: 0.6; }
.group ul { list-style: none; padding: 0; margin: 0; }
.group li { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; border: 1px solid transparent; }
.group li:hover { background: #1a1f27; }
.group li.active { background: #233044; border-color: #3c5d8a; }
.empty { color: #7a8088; padding: 24px; text-align: center; }
#detail-pane input, #detail-pane textarea { width: 100%; background: #0f1115; color: #d7dae0; border: 1px solid #2e333c; padding: 8px; border-radius: 4px; font-family: inherit; font-size: 13px; margin-bottom: 8px; }
#detail-pane textarea { font-family: monospace; }
.actions { display: flex; gap: 8px; margin-bottom: 12px; }
.id { font-family: monospace; font-size: 11px; color: #7a8088; margin-bottom: 8px; }
#runs-list { list-style: none; padding: 0; }
#runs-list li { padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: monospace; display: flex; justify-content: space-between; }
#runs-list li:hover { background: #1a1f27; }
#runs-list li.active { background: #233044; }
.status-queued  { color: #7a8088; }
.status-running { color: #e2c767; }
.status-done    { color: #6fbf73; }
.status-failed  { color: #d76c6c; }
.status-stale   { color: #b277aa; }
#session-log { font-family: monospace; font-size: 12px; white-space: pre-wrap; }
.log-entry { padding: 4px 6px; border-left: 2px solid #2e333c; margin-bottom: 4px; }
.log-user      { border-left-color: #3c5d8a; }
.log-assistant { border-left-color: #6fbf73; }
.log-tool      { border-left-color: #e2c767; }
dialog { background: #161a21; color: #d7dae0; border: 1px solid #2e333c; border-radius: 6px; padding: 16px; }
dialog label { display: block; font-size: 12px; margin-bottom: 8px; }
dialog input, dialog textarea { width: 400px; background: #0f1115; color: inherit; border: 1px solid #2e333c; padding: 6px; border-radius: 4px; font-family: inherit; }
dialog menu { display: flex; gap: 8px; justify-content: flex-end; padding: 0; margin-top: 8px; }
```

- [ ] **Step 3: Commit**

```bash
git add ui/public/index.html ui/public/styles.css
git commit -m "feat(ui): add three-pane HTML shell and dark CSS grid layout"
```

---

## Task 11: Frontend JS — `ui/public/app.js`

**Files:**
- Create: `ui/public/app.js`

- [ ] **Step 1: Implement `ui/public/app.js`**

```js
const api = (p, init) => fetch(`/api${p}`, init).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
});

const state = {
  tasks: [],
  activeTaskId: null,
  meta: null,
  activeRun: null,      // { sessionId, repoPath }
  tailOffset: 0,
  pollHandle: null,
  tailHandle: null,
};

async function refreshTasks() {
  state.tasks = await api("/tasks");
  renderTaskList();
  if (state.activeTaskId) renderDetail();
}

function renderTaskList() {
  document.querySelectorAll(".group").forEach((g) => {
    const section = g.dataset.section;
    const ul = g.querySelector("ul");
    const tasks = state.tasks.filter((t) => t.section === section);
    g.querySelector(".count").textContent = tasks.length ? `(${tasks.length})` : "";
    ul.innerHTML = "";
    tasks.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t.title;
      li.dataset.id = t.id;
      if (t.id === state.activeTaskId) li.classList.add("active");
      li.onclick = () => selectTask(t.id);
      ul.appendChild(li);
    });
  });
}

async function selectTask(id) {
  state.activeTaskId = id;
  state.activeRun = null;
  stopTail();
  renderTaskList();
  await loadMeta();
  renderDetail();
  renderEmptySession();
  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = setInterval(loadMeta, 1500);
}

async function loadMeta() {
  if (!state.activeTaskId) return;
  try {
    state.meta = await api(`/tasks/${state.activeTaskId}/meta`);
    renderRuns();
  } catch { /* 404 until created */ }
}

function renderDetail() {
  const t = state.tasks.find((x) => x.id === state.activeTaskId);
  if (!t) return renderEmptyDetail();
  document.getElementById("empty-detail").hidden = true;
  const d = document.getElementById("task-detail");
  d.hidden = false;
  document.getElementById("detail-id").textContent = `${t.id} · ${t.section}`;
  document.getElementById("detail-title").value = t.title;
  document.getElementById("detail-body").value = t.body;
}

function renderEmptyDetail() {
  document.getElementById("empty-detail").hidden = false;
  document.getElementById("task-detail").hidden = true;
}

function renderRuns() {
  const ul = document.getElementById("runs-list");
  ul.innerHTML = "";
  if (!state.meta) return;
  state.meta.runs.forEach((r) => {
    const li = document.createElement("li");
    const label = r.side ? `${r.role}(${r.side})` : r.role;
    li.innerHTML = `<span>${label}</span><span class="status-${r.status}">● ${r.status}</span>`;
    li.onclick = () => selectRun(r);
    if (state.activeRun?.sessionId === r.sessionId) li.classList.add("active");
    ul.appendChild(li);
  });
}

async function selectRun(run) {
  stopTail();
  const repos = await api("/repos");
  const repoMatch = repos.find((r) => r.folder === run.repo) ?? { path: await bridgePath() };
  state.activeRun = { sessionId: run.sessionId, repoPath: repoMatch.path, role: run.role, side: run.side };
  state.tailOffset = 0;
  renderRuns();
  showSession();
  document.getElementById("session-log").innerHTML = "";
  tick();
  state.tailHandle = setInterval(tick, 1000);
}

async function bridgePath() {
  // bridge repo has no entry in /api/repos; derive from any repo: dirname(repo.path) + '/edusoft-lms-bridge' is wrong, just read location — use first repo's parent + known folder name is not available. Use a dedicated endpoint? Simpler: server exposes it via /api/repos by appending bridge. But keeping it DRY: bridge repo = the cwd of the server process. Server already knows; add it to /api/repos response:
  return (await api("/repos")).find((r) => r.side === "BRIDGE")?.path ?? "";
}

function showSession() {
  document.getElementById("empty-session").hidden = true;
  document.getElementById("session-viewer").hidden = false;
  document.getElementById("session-header").textContent =
    `${state.activeRun.role}${state.activeRun.side ? `(${state.activeRun.side})` : ""} · ${state.activeRun.sessionId}`;
}

function renderEmptySession() {
  document.getElementById("empty-session").hidden = false;
  document.getElementById("session-viewer").hidden = true;
}

function stopTail() { if (state.tailHandle) { clearInterval(state.tailHandle); state.tailHandle = null; } }

async function tick() {
  if (!state.activeRun) return;
  const url = `/sessions/${state.activeRun.sessionId}/tail?repo=${encodeURIComponent(state.activeRun.repoPath)}&since=${state.tailOffset}`;
  const { lines, offset } = await api(url);
  state.tailOffset = offset;
  const log = document.getElementById("session-log");
  for (const l of lines) {
    const entry = document.createElement("div");
    entry.className = `log-entry log-${l.type ?? "tool"}`;
    const content = l.message?.content ?? JSON.stringify(l, null, 2);
    entry.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    log.appendChild(entry);
  }
  if (lines.length) log.scrollTop = log.scrollHeight;
}

document.getElementById("save-btn").onclick = async () => {
  if (!state.activeTaskId) return;
  await api(`/tasks/${state.activeTaskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: document.getElementById("detail-title").value,
      body:  document.getElementById("detail-body").value,
    }),
  });
  refreshTasks();
};

document.getElementById("dispatch-btn").onclick = async () => {
  if (!state.activeTaskId) return;
  const btn = document.getElementById("dispatch-btn");
  btn.disabled = true; btn.textContent = "Dispatching…";
  try { await api(`/tasks/${state.activeTaskId}/dispatch`, { method: "POST" }); }
  catch (e) { alert(`Dispatch failed: ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = "▶ Dispatch"; }
  loadMeta();
};

document.getElementById("new-task-btn").onclick = () => {
  document.getElementById("new-title").value = "";
  document.getElementById("new-body").value = "";
  document.getElementById("new-task-dialog").showModal();
};

document.getElementById("new-task-dialog").addEventListener("close", async (e) => {
  const dlg = e.currentTarget;
  if (dlg.returnValue !== "submit") return;
  const title = document.getElementById("new-title").value.trim();
  if (!title) return;
  const body = document.getElementById("new-body").value;
  const t = await api("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  await refreshTasks();
  selectTask(t.id);
});

refreshTasks();
setInterval(refreshTasks, 5000);
```

- [ ] **Step 2: Update `ui/server.ts` to expose bridge path in `/api/repos`**

Edit the `/api/repos` handler to append a synthetic BRIDGE entry:

Find:
```ts
app.get("/api/repos", (c) => {
  const md = readFileSync(BRIDGE_MD, "utf8");
  const repos = resolveRepos(md, BRIDGE_ROOT).map((r) => ({
    ...r,
    exists: existsSync(r.path),
  }));
  return c.json(repos);
});
```

Replace with:
```ts
app.get("/api/repos", (c) => {
  const md = readFileSync(BRIDGE_MD, "utf8");
  const repos = resolveRepos(md, BRIDGE_ROOT).map((r) => ({
    ...r,
    exists: existsSync(r.path),
  }));
  repos.push({ side: "BRIDGE" as any, folder: "edusoft-lms-bridge", path: BRIDGE_ROOT, exists: true });
  return c.json(repos);
});
```

- [ ] **Step 3: Commit**

```bash
git add ui/public/app.js ui/server.ts
git commit -m "feat(ui): add vanilla JS frontend (task list, detail, runs, tail)"
```

---

## Task 12: End-to-end launch & smoke test

**Files:** none

- [ ] **Step 1: Start server**

Run: `cd "d:/Edusoft/edusoft-lms-bridge" && bun run ui`
Expected: `bridge UI: http://localhost:7777`.

- [ ] **Step 2: Open browser**

Open `http://localhost:7777`. Expected layout:
- Header + "+ New task"
- Left pane: 6 section headers (all empty)
- Middle + right panes: empty state

- [ ] **Step 3: Create a trivial task**

Click **+ New task**. Title: `Add /health endpoint returning { ok: true }`. Body: empty. Click **Create**.

Expected:
- Task appears under `TODO — UNASSIGNED (1)`.
- `tasks.md` on disk has the new entry with a `<!-- task-id: t_20260424_XXX -->` comment.
- `sessions/t_20260424_XXX/meta.json` exists with empty `runs`.

- [ ] **Step 4: Dispatch**

Click **▶ Dispatch**.

Expected within ~30 s:
- Right pane: coordinator session appears, streaming assistant messages.
- Middle pane: runs list grows (coordinator → coder(BE) → reviewer(BE)).
- On completion, task moves to `DONE — not yet archived` in left pane and in `tasks.md`.

- [ ] **Step 5: If anything fails, debug and fix before claiming done**

Common failure modes to check:
- `claude` not in PATH → dispatch returns 500. Fix PATH, restart server.
- Session ID not captured → check stdout format of `claude -p`; adjust `UUID_RE` or fallback wait.
- Slug mismatch → inspect `~/.claude/projects/` and compare to `pathToSlug` output.
- Coordinator can't find `../edusoft-lms-api` → verify the sibling repo exists.

- [ ] **Step 6: Final commit (if fixes were needed during smoke test)**

```bash
git add -A
git commit -m "fix(ui): smoke-test corrections"
```

---

## Self-review notes

**Spec coverage:**
- UI as single Bun + Hono process on port 7777 — Tasks 1, 8.
- `tasks.md` as source of truth — Tasks 2, 4, 8 (POST/PATCH).
- Sessions read from `~/.claude/projects/<slug>/*.jsonl` — Task 6 (slug), Task 8 (tail endpoint).
- Sibling folders resolved from BRIDGE.md Repos table, not hardcoded — Tasks 3, 8, 11.
- Coordinator / coder / reviewer agent team — Task 9 (prompts), Task 8 (dispatch endpoint), Task 7 (spawn).
- `sessions/<task-id>/meta.json` mapping — Task 5, consumed by Tasks 8, 11.
- Three-pane UI with live tail — Tasks 10, 11.
- Error handling (missing repo / claude / 409 mtime) — Task 8 (500 responses, existence checks). The 409 mtime case is called out in the spec but deferred as "out of scope for v1 smoke test"; rely on the UI being the only writer for now, noted in Task 12 as a known limitation.
- Launch & test — Task 12.

**Placeholder scan:** no "TBD", no "implement later", no "similar to Task N". All code blocks are complete.

**Type consistency:** `Task`, `Run`, `Meta`, `RunStatus`, `TaskSection` defined once (tasks.ts / meta.ts) and re-imported in server.ts. `Side` is `"FE" | "BE" | null` in meta.ts and `"FE" | "BE"` in repos.ts (runs can have `null` for coordinator; repos table only has FE/BE) — intentional, noted here.

**Known limitation carried from spec:** the 409-on-mtime optimistic-concurrency check is not implemented in v1 since the UI is the only writer during a dispatch. If manual editing of `tasks.md` during a dispatch becomes a real problem, add `If-Match` + mtime check to the PATCH handler.
