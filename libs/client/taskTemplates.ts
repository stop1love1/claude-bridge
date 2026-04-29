/**
 * Task templates the New Task dialog can pre-fill from. Built-in
 * templates cover the most common patterns (bug fix, feature, refactor,
 * doc, security review). User-defined templates are persisted to
 * localStorage so they survive reloads but stay private to the browser.
 */
export interface TaskTemplate {
  id: string;
  label: string;
  body: string;
  /** Set to true on built-ins so the UI can hide the delete button. */
  builtin?: boolean;
}

const STORAGE_KEY = "bridge.tasks.templates";

export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  {
    id: "builtin:bug",
    label: "Bug fix",
    builtin: true,
    body: `Fix: <one-line summary of the bug>

Repro steps:
1.
2.
3.

Expected:
Actual:

Acceptance:
- [ ] Repro no longer triggers the failure
- [ ] Regression test added
`,
  },
  {
    id: "builtin:feature",
    label: "Feature",
    builtin: true,
    body: `Build: <one-line user-facing capability>

Why:
Scope:
- in:
- out:

Acceptance:
- [ ]
- [ ]
`,
  },
  {
    id: "builtin:refactor",
    label: "Refactor",
    builtin: true,
    body: `Refactor: <subject of the refactor>

Goal: keep behavior identical, change <structure / naming / module split>.

Out of scope:
- new features
- behavioral changes (call out any forced exception)

Acceptance:
- [ ] All existing tests pass
- [ ] Public surface unchanged (or migration noted)
`,
  },
  {
    id: "builtin:doc",
    label: "Docs",
    builtin: true,
    body: `Document: <feature / API / module>

Audience:
Outline:
1.
2.

Acceptance:
- [ ] Reads cleanly to a newcomer
- [ ] Code samples compile / paste-runnable
`,
  },
  {
    id: "builtin:review",
    label: "Security review",
    builtin: true,
    body: `Security review: <module / endpoint / flow>

Threats to consider:
- input validation / injection
- auth / authz boundaries
- data exposure (logs, errors, stored)
- supply-chain / deps

Deliverable: a findings list ranked critical → low, with concrete remediations.
`,
  },
];

export function loadUserTemplates(): TaskTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is TaskTemplate =>
        !!t && typeof t === "object" &&
        typeof (t as TaskTemplate).id === "string" &&
        typeof (t as TaskTemplate).label === "string" &&
        typeof (t as TaskTemplate).body === "string",
      )
      .map((t) => ({ ...t, builtin: false }));
  } catch {
    return [];
  }
}

export function saveUserTemplates(list: TaskTemplate[]): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.filter((t) => !t.builtin))); }
  catch { /* quota */ }
}

export function addUserTemplate(label: string, body: string): TaskTemplate {
  const t: TaskTemplate = {
    id: `user:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: label.trim(),
    body,
    builtin: false,
  };
  const list = [...loadUserTemplates(), t];
  saveUserTemplates(list);
  return t;
}

export function removeUserTemplate(id: string): void {
  saveUserTemplates(loadUserTemplates().filter((t) => t.id !== id));
}

export function allTemplates(): TaskTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadUserTemplates()];
}
