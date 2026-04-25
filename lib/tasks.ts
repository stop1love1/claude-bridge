export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskSection = "TODO" | "DOING" | "BLOCKED" | "DONE — not yet archived";

export interface Task {
  id: string;
  date: string;          // YYYY-MM-DD
  title: string;
  body: string;          // everything after the title line, excluding blank tail
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;      // [x] vs [ ]
  /** Target app name; `null` means "auto" (coordinator decides). */
  app?: string | null;
}

export const SECTION_STATUS: Record<TaskSection, TaskStatus> = {
  TODO: "todo",
  DOING: "doing",
  BLOCKED: "blocked",
  "DONE — not yet archived": "done",
};
const ALL_SECTIONS = Object.keys(SECTION_STATUS) as TaskSection[];

export function parseTasks(md: string): Task[] {
  const tasks: Task[] = [];
  const footerIdx = md.indexOf("\n---\n");
  const active = footerIdx === -1 ? md : md.slice(0, footerIdx);
  // Section header: must be one of the 4 exact labels, end of line
  const sectionRe = /^## (TODO|DOING|BLOCKED|DONE — not yet archived)\s*$/gm;
  const matches = [...active.matchAll(sectionRe)];
  for (let i = 0; i < matches.length; i++) {
    const section = matches[i][1] as TaskSection;
    const start = matches[i].index! + matches[i][0].length;
    const nextStart = i + 1 < matches.length ? matches[i + 1].index! : active.length;
    const block = active.slice(start, nextStart);
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
  for (const section of ALL_SECTIONS) {
    const escaped = section.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(
      `(## ${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`,
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
  if (section === "BLOCKED") {
    return "_(none — blocked tasks go here with the reason and a link to `questions.md` if waiting for an answer)_";
  }
  return "_(none)_";
}

/**
 * Strict task ID format: `t_YYYYMMDD_NNN`. Used as both the slug and a
 * trust gate before any path join under `SESSIONS_DIR` — anything that
 * doesn't match this regex must be rejected to prevent traversal
 * (`../`, `/`, `\`, drive letters, null bytes, …).
 */
const TASK_ID_RE = /^t_\d{8}_\d{3}$/;

export function isValidTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_RE.test(id);
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
