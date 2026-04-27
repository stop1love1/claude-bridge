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
  /**
   * XHR-backed variant that surfaces upload progress (0–1 fraction).
   * `fetch` doesn't expose `progress` events; XHR does. We keep both
   * helpers around so callers that don't care about progress aren't
   * forced to wire callbacks.
   */
  uploadFileWithProgress: (
    sessionId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<{ path: string; name: string; size: number }> => {
    return new Promise((resolveP, rejectP) => {
      const fd = new FormData();
      fd.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/sessions/${sessionId}/upload`);
      xhr.upload.addEventListener("progress", (ev) => {
        if (!ev.lengthComputable) return;
        onProgress(Math.min(1, ev.loaded / ev.total));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolveP(JSON.parse(xhr.responseText)); }
          catch (e) { rejectP(e); }
        } else {
          rejectP(new Error(`${xhr.status} ${xhr.responseText || xhr.statusText}`));
        }
      });
      xhr.addEventListener("error", () => rejectP(new Error("network error")));
      xhr.addEventListener("abort", () => rejectP(new Error("aborted")));
      xhr.send(fd);
    });
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
  runDiff: (taskId: string, sessionId: string) =>
    req<{ kind: "worktree" | "live"; cwd: string; diff: string; truncated?: boolean }>(
      `/tasks/${taskId}/runs/${sessionId}/diff`,
    ),
  taskUsage: (taskId: string) =>
    req<{
      taskId: string;
      total: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        turns: number;
      };
      runs: Array<{
        sessionId: string;
        role: string;
        repo: string;
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        turns: number;
      }>;
    }>(`/tasks/${taskId}/usage`),
  telegramTest: () =>
    req<{ ok: true } | { ok: false; reason: string }>(`/telegram/test`, { method: "POST" })
      .catch((e: Error) => {
        // The route returns 503 with a JSON body when not configured;
        // surface that as a structured error rather than a thrown one
        // so the caller can show the reason in a toast.
        const m = /^503 (.+)$/.exec(e.message);
        if (m) {
          try { return JSON.parse(m[1]) as { ok: false; reason: string }; }
          catch { return { ok: false, reason: e.message }; }
        }
        return { ok: false, reason: e.message };
      }),
  telegramSettings: () =>
    req<{
      botToken: string;
      botTokenSet: boolean;
      chatId: string;
      forwardChat: "off" | "coordinator-only" | "all";
      forwardChatMinChars: number;
    }>(`/telegram/settings`),
  updateTelegramSettings: (patch: {
    botToken?: string;
    chatId?: string;
    forwardChat?: "off" | "coordinator-only" | "all";
    forwardChatMinChars?: number;
  }) =>
    req<{
      botToken: string;
      botTokenSet: boolean;
      chatId: string;
      forwardChat: "off" | "coordinator-only" | "all";
      forwardChatMinChars: number;
    }>(`/telegram/settings`, { method: "PUT", body: JSON.stringify(patch) }),
  telegramUserSettings: () =>
    req<{
      apiId: number;
      apiHash: string;
      apiHashSet: boolean;
      session: string;
      sessionSet: boolean;
      targetChatId: string;
    }>(`/telegram/user/settings`),
  updateTelegramUserSettings: (
    patch: { apiId?: number; apiHash?: string; session?: string; targetChatId?: string },
  ) =>
    req<{
      apiId: number;
      apiHash: string;
      apiHashSet: boolean;
      session: string;
      sessionSet: boolean;
      targetChatId: string;
    }>(`/telegram/user/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  clearTelegramUserSettings: () =>
    req<{ ok: true }>(`/telegram/user/settings`, { method: "DELETE" }),
  telegramUserTest: (): Promise<
    | { ok: true; me: { id: string; username: string; firstName: string; phone: string } }
    | { ok: false; reason: string }
  > =>
    req<
      | { ok: true; me: { id: string; username: string; firstName: string; phone: string } }
      | { ok: false; reason: string }
    >(`/telegram/user/test`, { method: "POST" })
      .catch((e: Error): { ok: false; reason: string } => {
        const m = /^503 (.+)$/.exec(e.message);
        if (m) {
          try { return JSON.parse(m[1]) as { ok: false; reason: string }; }
          catch { return { ok: false, reason: e.message }; }
        }
        return { ok: false, reason: e.message };
      }),
  detectSettings: () =>
    req<{ source: "auto" | "llm" | "heuristic" }>(`/detect/settings`),
  updateDetectSettings: (patch: { source: "auto" | "llm" | "heuristic" }) =>
    req<{ source: "auto" | "llm" | "heuristic" }>(`/detect/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  scanApp: (name: string) =>
    req<{
      ok: true;
      app: App;
      scanned: boolean;
      description: string;
      reason?: string;
    }>(`/apps/${encodeURIComponent(name)}/scan`, { method: "POST" }),
  authDevices: () =>
    req<{
      currentDeviceId: string | null;
      devices: Array<{
        id: string;
        label: string | null;
        createdAt: string;
        lastSeenAt: string;
        expiresAt: string;
        isCurrent: boolean;
      }>;
    }>(`/auth/devices`),
  revokeAuthDevice: (id: string) =>
    req<{ ok: boolean }>(`/auth/devices?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
