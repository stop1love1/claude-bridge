import type {
  Task,
  Meta,
  Repo,
  SessionSummary,
  ChatSettings,
  App,
  AppGitSettings,
} from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  repos: () => req<Repo[]>("/repos"),
  tasks: () => req<Task[]>("/tasks"),
  createTask: (body: { title?: string; body: string; app?: string | null }) =>
    req<Task>("/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, patch: Partial<Task>) =>
    req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (id: string) =>
    req<{ ok: true; sessionsDeleted: number; sessionsFailed: number }>(
      `/tasks/${id}`,
      { method: "DELETE" },
    ),
  meta: (id: string) => req<Meta>(`/tasks/${id}/meta`),
  allMeta: () => req<Record<string, Meta>>("/tasks/meta"),
  summary: (id: string) => req<{ summary: string }>(`/tasks/${id}/summary`),
  runPrompt: (taskId: string, sessionId: string) =>
    req<{ prompt: string }>(`/tasks/${taskId}/runs/${sessionId}/prompt`),
  continueTask: (id: string) =>
    req<{ action: "resumed" | "spawned"; sessionId?: string }>(`/tasks/${id}/continue`, { method: "POST" }),
  tail: (sessionId: string, repo: string, since: number) =>
    req<{ lines: unknown[]; offset: number; lineOffsets: number[] }>(
      `/sessions/${sessionId}/tail?repo=${encodeURIComponent(repo)}&since=${since}`,
    ),
  tailBefore: (sessionId: string, repo: string, beforeOffset: number) =>
    req<{ lines: unknown[]; fromOffset: number; beforeOffset: number; lineOffsets: number[] }>(
      `/sessions/${sessionId}/tail?repo=${encodeURIComponent(repo)}&before=${beforeOffset}`,
    ),
  allSessions: () => req<SessionSummary[]>("/sessions/all"),
  sendMessage: (
    sessionId: string,
    body: { message: string; repo: string; settings?: ChatSettings },
  ) =>
    req<{ ok: true }>(`/sessions/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  killSession: (sessionId: string) =>
    req<{ ok: true; sessionId: string; action: "killed" }>(
      `/sessions/${sessionId}/kill`,
      { method: "POST" },
    ),
  linkSessionToTask: (
    taskId: string,
    body: { sessionId: string; role: string; repo: string },
  ) =>
    req<{ ok: true }>(`/tasks/${taskId}/link`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  files: (repo: string, query: string) =>
    req<Array<{ rel: string; path: string }>>(
      `/repos/${encodeURIComponent(repo)}/files?q=${encodeURIComponent(query)}`,
    ),
  uploadFile: async (sessionId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/sessions/${sessionId}/upload`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<{ path: string; name: string; size: number }>;
  },
  rewind: (sessionId: string, body: { repo: string; uuid: string }) =>
    req<{ ok: true; kept: number; dropped: number }>(
      `/sessions/${sessionId}/rewind`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  clearTask: (id: string) =>
    req<{ action: "spawned"; sessionId: string }>(
      `/tasks/${id}/clear`,
      { method: "POST" },
    ),
  deleteSession: (sessionId: string, repo?: string) =>
    req<{ ok: true; fileRemoved: string | null; unlinkedFromTasks: string[] }>(
      repo
        ? `/sessions/${sessionId}?repo=${encodeURIComponent(repo)}`
        : `/sessions/${sessionId}`,
      { method: "DELETE" },
    ),
  createSession: (body: { repo: string; prompt: string; settings?: ChatSettings }) =>
    req<{ sessionId: string; repo: string; cwd: string }>(
      "/sessions",
      { method: "POST", body: JSON.stringify(body) },
    ),
  apps: () => req<App[]>("/apps"),
  addApp: (body: { name: string; path: string; description?: string }) =>
    req<App>("/apps", { method: "POST", body: JSON.stringify(body) }),
  removeApp: (name: string) =>
    req<{ ok: true }>(`/apps/${encodeURIComponent(name)}`, { method: "DELETE" }),
  updateApp: (
    name: string,
    patch: { name?: string; description?: string; git?: Partial<AppGitSettings> },
  ) =>
    req<App & { migratedTasks?: number }>(`/apps/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  autoDetectApps: () =>
    req<{
      added: App[];
      skipped: Array<{ name: string; reason: "already-registered" | "not-a-repo" }>;
    }>("/apps/auto-detect", { method: "POST" }),
  scanApp: (name: string) =>
    req<{
      ok: true;
      app: App;
      scanned: boolean;
      description: string;
      reason?: string;
    }>(`/apps/${encodeURIComponent(name)}/scan`, { method: "POST" }),
};
