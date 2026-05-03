// Thin REST client for the bridge backend. Reads the operator's
// internal token from localStorage and attaches it to every request as
// `X-Bridge-Internal-Token`. When the bridge runs with --localhost-only
// the loopback connection bypasses auth and the token may be empty.
//
// On a 401 we redirect to /settings?reason=auth so the operator can
// paste a fresh token without losing their place.
//
// Method grouping: tasks → sessions → apps → repos → tunnels →
// permission → upload → misc. Each domain block is a record on the
// exported `api` object so callers do `api.tasks.list()` etc. The
// flat top-level methods preserved at the bottom are legacy aliases
// the existing dashboard pages still call.

import type {
  AddAppBody,
  AnnouncePermissionBody,
  AnswerPermissionBody,
  App,
  AppsResponse,
  AppMemoryResponse,
  AppendAppMemoryBody,
  AppendAppMemoryResponse,
  AutoDetectResponse,
  BridgeSettings,
  BulkAddAppEntry,
  ClearTaskResponse,
  ContinueTaskResponse,
  CreateTaskBody,
  CreateTunnelBody,
  CreateTunnelResponse,
  DeleteTaskResponse,
  DetectRefreshResponse,
  HealthResponse,
  KillRunResponse,
  LinkSessionBody,
  LinkSessionResponse,
  NgrokAuthtokenResponse,
  PatchTaskBody,
  PermissionPendingResponse,
  PermissionRequest,
  RefreshRepoProfilesResponse,
  Repo,
  RepoFilesResponse,
  RepoProfile,
  RepoProfilesResponse,
  RepoRawFileResponse,
  ReposResponse,
  RunDiffResponse,
  RunPromptResponse,
  ScanAppResponse,
  SessionMessageBody,
  SessionMessageResponse,
  SessionRewindBody,
  SessionRewindResponse,
  SessionSummary,
  SessionTailBackward,
  SessionTailForward,
  SetNgrokAuthtokenBody,
  SlashCommandsResponse,
  Task,
  TaskMeta,
  TaskMetaList,
  TaskMetaMap,
  TaskUsageResponse,
  TunnelInstallResult,
  TunnelProvidersResponse,
  TunnelsResponse,
  UploadResponse,
  UsageResponse,
  AgentSpawnBody,
  AgentSpawnResponse,
} from "@/api/types";

const TOKEN_KEY = "bridge.token";

const API_BASE: string =
  // Vite injects this at build time; absent in prod (same-origin).
  (import.meta as unknown as { env: { VITE_API_BASE?: string } }).env
    .VITE_API_BASE ?? "";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage unavailable (private mode etc.) — nothing useful to
    // do here; the token simply won't persist across reloads.
  }
}

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  // When true the auth-redirect on 401 is suppressed (used by the
  // settings page so a deliberate "test connection" doesn't bounce the
  // operator back to themselves).
  silentAuth?: boolean;
  // Override the default JSON content-type — used by the multipart
  // upload helper which lets the browser pick the boundary.
  rawBody?: BodyInit;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const token = getToken();
  if (token) headers["x-bridge-internal-token"] = token;

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
    signal: opts.signal,
  });

  if (res.status === 401 && !opts.silentAuth) {
    // Redirect rather than throwing so callers don't have to thread
    // auth handling through every query. /settings reads `?reason=auth`
    // to surface a banner.
    if (typeof window !== "undefined") {
      window.location.replace("/settings?reason=auth");
    }
    throw new ApiError(401, "unauthorized");
  }

  if (!res.ok) {
    let parsed: unknown = undefined;
    try {
      parsed = await res.json();
    } catch {
      // body wasn't JSON; ignore
    }
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : "") || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, parsed);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  // text fallback (summary.md endpoint returns text/markdown)
  return (await res.text()) as unknown as T;
}

// ---- helpers ------------------------------------------------------------

function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---- tasks --------------------------------------------------------------

const tasks = {
  /** GET /api/tasks — lite list (no runs). */
  list(opts?: { signal?: AbortSignal }): Promise<Task[]> {
    return request<Task[]>("/api/tasks", { signal: opts?.signal });
  },
  /** GET /api/tasks/meta — full meta map keyed by task id. */
  meta(opts?: { signal?: AbortSignal }): Promise<TaskMetaMap> {
    return request<TaskMetaMap>("/api/tasks/meta", { signal: opts?.signal });
  },
  /** GET /api/tasks/{id} — task header (Task shape). */
  get(id: string): Promise<Task> {
    return request<Task>(`/api/tasks/${enc(id)}`);
  },
  /** GET /api/tasks/{id}/meta — task header + runs. */
  getMeta(id: string): Promise<TaskMeta> {
    return request<TaskMeta>(`/api/tasks/${enc(id)}/meta`);
  },
  /** POST /api/tasks. Returns the created task header (also carries
   *  an `error` field when the coordinator failed to spawn). */
  create(body: CreateTaskBody): Promise<Task & { error?: string }> {
    return request<Task & { error?: string }>("/api/tasks", {
      method: "POST",
      body,
    });
  },
  /** PATCH /api/tasks/{id}. */
  patch(id: string, patch: PatchTaskBody): Promise<Task> {
    return request<Task>(`/api/tasks/${enc(id)}`, { method: "PATCH", body: patch });
  },
  /** DELETE /api/tasks/{id}. */
  delete(id: string): Promise<DeleteTaskResponse> {
    return request<DeleteTaskResponse>(`/api/tasks/${enc(id)}`, { method: "DELETE" });
  },
  /** GET /api/tasks/{id}/summary — JSON envelope `{summary}`. */
  summary(id: string): Promise<{ summary: string }> {
    return request<{ summary: string }>(`/api/tasks/${enc(id)}/summary`);
  },
  /** PUT /api/tasks/{id}/summary. */
  putSummary(id: string, summary: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/tasks/${enc(id)}/summary`, {
      method: "PUT",
      body: { summary },
    });
  },
  /** GET /api/tasks/{id}/usage — per-run token / cost breakdown. */
  usage(id: string, opts?: { signal?: AbortSignal }): Promise<TaskUsageResponse> {
    return request<TaskUsageResponse>(`/api/tasks/${enc(id)}/usage`, {
      signal: opts?.signal,
    });
  },
  /** POST /api/tasks/{id}/agents — coordinator spawns a child. */
  spawnAgent(id: string, body: AgentSpawnBody): Promise<AgentSpawnResponse> {
    return request<AgentSpawnResponse>(`/api/tasks/${enc(id)}/agents`, {
      method: "POST",
      body,
    });
  },
  /** POST /api/tasks/{id}/continue — resume the coordinator. */
  continue(
    id: string,
    body?: { prompt?: string },
  ): Promise<ContinueTaskResponse> {
    return request<ContinueTaskResponse>(`/api/tasks/${enc(id)}/continue`, {
      method: "POST",
      body: body ?? {},
    });
  },
  /** POST /api/tasks/{id}/clear — drop existing runs + respawn coordinator. */
  clear(id: string): Promise<ClearTaskResponse> {
    return request<ClearTaskResponse>(`/api/tasks/${enc(id)}/clear`, {
      method: "POST",
      body: {},
    });
  },
  /** POST /api/tasks/{id}/link — child self-registration. */
  link(id: string, body: LinkSessionBody): Promise<LinkSessionResponse> {
    return request<LinkSessionResponse>(`/api/tasks/${enc(id)}/link`, {
      method: "POST",
      body,
    });
  },
  /** POST /api/tasks/{id}/detect/refresh — kicks the auto-detect pipeline. */
  refreshDetect(id: string): Promise<DetectRefreshResponse> {
    return request<DetectRefreshResponse>(`/api/tasks/${enc(id)}/detect/refresh`, {
      method: "POST",
      body: {},
    });
  },
  /** GET /api/tasks/{id}/runs/{sid}/prompt. */
  runPrompt(taskId: string, sessionId: string): Promise<RunPromptResponse> {
    return request<RunPromptResponse>(
      `/api/tasks/${enc(taskId)}/runs/${enc(sessionId)}/prompt`,
    );
  },
  /** GET /api/tasks/{id}/runs/{sid}/diff. */
  runDiff(
    taskId: string,
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RunDiffResponse> {
    return request<RunDiffResponse>(
      `/api/tasks/${enc(taskId)}/runs/${enc(sessionId)}/diff`,
      { signal: opts?.signal },
    );
  },
  /** POST /api/tasks/{id}/runs/{sid}/kill — scoped variant. */
  killRun(taskId: string, sessionId: string): Promise<KillRunResponse> {
    return request<KillRunResponse>(
      `/api/tasks/${enc(taskId)}/runs/${enc(sessionId)}/kill`,
      { method: "POST", body: {} },
    );
  },
};

// ---- sessions -----------------------------------------------------------

const sessions = {
  /** GET /api/sessions/all — every known session row across registered repos. */
  all(opts?: { signal?: AbortSignal }): Promise<SessionSummary[]> {
    return request<SessionSummary[]>("/api/sessions/all", { signal: opts?.signal });
  },
  /** GET /api/sessions/{sid}/tail?repo=&since=. Forward window. */
  tail(
    sessionId: string,
    repo: string,
    since: number,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionTailForward> {
    return request<SessionTailForward>(
      `/api/sessions/${enc(sessionId)}/tail?repo=${enc(repo)}&since=${since}`,
      { signal: opts?.signal },
    );
  },
  /** GET /api/sessions/{sid}/tail?repo=&before=. Backward window. */
  tailBefore(
    sessionId: string,
    repo: string,
    beforeOffset: number,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionTailBackward> {
    return request<SessionTailBackward>(
      `/api/sessions/${enc(sessionId)}/tail?repo=${enc(repo)}&before=${beforeOffset}`,
      { signal: opts?.signal },
    );
  },
  /** POST /api/sessions/{sid}/kill — global session kill. */
  kill(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/sessions/${enc(sessionId)}/kill`, {
      method: "POST",
      body: {},
    });
  },
  /** POST /api/sessions/{sid}/message — append a user turn. */
  message(
    sessionId: string,
    body: SessionMessageBody,
  ): Promise<SessionMessageResponse> {
    return request<SessionMessageResponse>(
      `/api/sessions/${enc(sessionId)}/message`,
      { method: "POST", body },
    );
  },
  /** POST /api/sessions/{sid}/rewind — truncate history at uuid. */
  rewind(
    sessionId: string,
    body: SessionRewindBody,
  ): Promise<SessionRewindResponse> {
    return request<SessionRewindResponse>(
      `/api/sessions/${enc(sessionId)}/rewind`,
      { method: "POST", body },
    );
  },
};

// ---- apps ---------------------------------------------------------------

const apps = {
  /** GET /api/apps — registry snapshot. */
  list(opts?: { signal?: AbortSignal }): Promise<AppsResponse> {
    return request<AppsResponse>("/api/apps", { signal: opts?.signal });
  },
  /** POST /api/apps — append one app. */
  add(body: AddAppBody): Promise<App> {
    return request<App>("/api/apps", { method: "POST", body });
  },
  /** POST /api/apps/bulk — atomic replace via the auto-detect dialog. */
  bulk(apps: BulkAddAppEntry[] | { apps: BulkAddAppEntry[] }): Promise<AppsResponse> {
    return request<AppsResponse>("/api/apps/bulk", {
      method: "POST",
      body: Array.isArray(apps) ? { apps } : apps,
    });
  },
  /** GET /api/apps/{name}. */
  get(name: string): Promise<App> {
    return request<App>(`/api/apps/${enc(name)}`);
  },
  /** DELETE /api/apps/{name}. */
  remove(name: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/apps/${enc(name)}`, { method: "DELETE" });
  },
  /** POST /api/apps/auto-detect — heuristic candidate scan (stub today). */
  autoDetect(): Promise<AutoDetectResponse> {
    return request<AutoDetectResponse>("/api/apps/auto-detect", {
      method: "POST",
      body: {},
    });
  },
  /** GET /api/apps/{name}/memory. */
  memory(name: string): Promise<AppMemoryResponse> {
    return request<AppMemoryResponse>(`/api/apps/${enc(name)}/memory`);
  },
  /** POST /api/apps/{name}/memory — append one entry. */
  appendMemory(
    name: string,
    body: AppendAppMemoryBody,
  ): Promise<AppendAppMemoryResponse> {
    return request<AppendAppMemoryResponse>(
      `/api/apps/${enc(name)}/memory`,
      { method: "POST", body },
    );
  },
  /** POST /api/apps/{name}/scan — re-runs symbol/quality/profile. */
  scan(name: string): Promise<ScanAppResponse> {
    return request<ScanAppResponse>(`/api/apps/${enc(name)}/scan`, {
      method: "POST",
      body: {},
    });
  },
};

// ---- repos --------------------------------------------------------------

const repos = {
  /** GET /api/repos. */
  list(opts?: { signal?: AbortSignal }): Promise<ReposResponse> {
    return request<ReposResponse>("/api/repos", { signal: opts?.signal });
  },
  /** GET /api/repos/{name}. */
  get(name: string): Promise<Repo> {
    return request<Repo>(`/api/repos/${enc(name)}`);
  },
  /** GET /api/repos/{name}/files?path=. Shallow listing. */
  files(
    name: string,
    path?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RepoFilesResponse> {
    const q = path ? `?path=${enc(path)}` : "";
    return request<RepoFilesResponse>(`/api/repos/${enc(name)}/files${q}`, {
      signal: opts?.signal,
    });
  },
  /** GET /api/repos/{name}/raw?path=. */
  raw(
    name: string,
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RepoRawFileResponse> {
    return request<RepoRawFileResponse>(
      `/api/repos/${enc(name)}/raw?path=${enc(path)}`,
      { signal: opts?.signal },
    );
  },
  /** GET /api/repos/{name}/slash-commands. */
  slashCommands(
    name: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SlashCommandsResponse> {
    return request<SlashCommandsResponse>(
      `/api/repos/${enc(name)}/slash-commands`,
      { signal: opts?.signal },
    );
  },
  /** GET /api/repos/profiles. */
  profiles(opts?: { signal?: AbortSignal }): Promise<RepoProfilesResponse> {
    return request<RepoProfilesResponse>("/api/repos/profiles", {
      signal: opts?.signal,
    });
  },
  /** POST /api/repos/profiles/refresh. Optional `repo` narrows to one. */
  refreshProfiles(
    body?: { repo?: string },
  ): Promise<RefreshRepoProfilesResponse> {
    return request<RefreshRepoProfilesResponse>(
      "/api/repos/profiles/refresh",
      { method: "POST", body: body ?? {} },
    );
  },
  /** GET /api/repos/profiles/{name}. */
  profile(name: string): Promise<RepoProfile> {
    return request<RepoProfile>(`/api/repos/profiles/${enc(name)}`);
  },
  /** DELETE /api/repos/profiles/{name}. */
  deleteProfile(name: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/repos/profiles/${enc(name)}`, {
      method: "DELETE",
    });
  },
};

// ---- tunnels ------------------------------------------------------------

const tunnels = {
  /** GET /api/tunnels. */
  list(opts?: { signal?: AbortSignal }): Promise<TunnelsResponse> {
    return request<TunnelsResponse>("/api/tunnels", { signal: opts?.signal });
  },
  /** POST /api/tunnels. */
  start(body: CreateTunnelBody): Promise<CreateTunnelResponse> {
    return request<CreateTunnelResponse>("/api/tunnels", { method: "POST", body });
  },
  /** DELETE /api/tunnels/{id}?purge=. */
  stop(id: string, purge = false): Promise<{ ok: boolean }> {
    const q = purge ? "?purge=1" : "";
    return request<{ ok: boolean }>(`/api/tunnels/${enc(id)}${q}`, {
      method: "DELETE",
    });
  },
  /** GET /api/tunnels/providers. */
  providers(opts?: { signal?: AbortSignal }): Promise<TunnelProvidersResponse> {
    return request<TunnelProvidersResponse>("/api/tunnels/providers", {
      signal: opts?.signal,
    });
  },
  /** POST /api/tunnels/providers/ngrok/install. */
  installNgrok(): Promise<TunnelInstallResult> {
    return request<TunnelInstallResult>(
      "/api/tunnels/providers/ngrok/install",
      { method: "POST", body: {} },
    );
  },
  /** GET /api/tunnels/providers/ngrok/authtoken. */
  getNgrokAuthtoken(): Promise<NgrokAuthtokenResponse> {
    return request<NgrokAuthtokenResponse>(
      "/api/tunnels/providers/ngrok/authtoken",
    );
  },
  /**
   * POST /api/tunnels/providers/ngrok/authtoken.
   *
   * Accepts either `{ token }` (the field the Go handler reads — see
   * `SetNgrokAuthtokenBody` in internal/api/tunnels.go) or
   * `{ authtoken }` (the legacy main field). The wrapper sends both
   * keys so a caller from either era keeps working.
   */
  setNgrokAuthtoken(
    body: SetNgrokAuthtokenBody | { authtoken: string },
  ): Promise<NgrokAuthtokenResponse> {
    const token =
      "token" in body ? body.token : (body as { authtoken: string }).authtoken;
    return request<NgrokAuthtokenResponse>(
      "/api/tunnels/providers/ngrok/authtoken",
      { method: "POST", body: { token, authtoken: token } },
    );
  },
};

// ---- permission ---------------------------------------------------------

const permission = {
  /** GET /api/permission — global pending list. */
  list(opts?: { signal?: AbortSignal }): Promise<PermissionPendingResponse> {
    return request<PermissionPendingResponse>("/api/permission", {
      signal: opts?.signal,
    });
  },
  /** POST /api/permission — hook-side announcement. */
  announce(body: AnnouncePermissionBody): Promise<PermissionRequest> {
    return request<PermissionRequest>("/api/permission", {
      method: "POST",
      body,
    });
  },
  /** POST /api/permission/{requestId} — operator decision (cross-session). */
  answer(
    requestId: string,
    body: AnswerPermissionBody,
  ): Promise<PermissionRequest> {
    return request<PermissionRequest>(`/api/permission/${enc(requestId)}`, {
      method: "POST",
      body,
    });
  },
  /** GET /api/sessions/{sid}/permission — pending list scoped to one session. */
  forSession(
    sessionId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<PermissionPendingResponse> {
    return request<PermissionPendingResponse>(
      `/api/sessions/${enc(sessionId)}/permission`,
      { signal: opts?.signal },
    );
  },
  /** GET /api/sessions/{sid}/permission/{requestId}. */
  getOne(sessionId: string, requestId: string): Promise<PermissionRequest> {
    return request<PermissionRequest>(
      `/api/sessions/${enc(sessionId)}/permission/${enc(requestId)}`,
    );
  },
  /** POST /api/sessions/{sid}/permission/{requestId} — scoped operator decision. */
  decideForSession(
    sessionId: string,
    requestId: string,
    body: AnswerPermissionBody,
  ): Promise<PermissionRequest> {
    return request<PermissionRequest>(
      `/api/sessions/${enc(sessionId)}/permission/${enc(requestId)}`,
      { method: "POST", body },
    );
  },
};

// ---- upload -------------------------------------------------------------

const uploads = {
  /**
   * POST /api/sessions/{sid}/upload — multipart, fetch-based.
   * Use `withProgress` when the caller cares about an upload-progress
   * indicator; fetch can't surface upload events.
   */
  async send(sessionId: string, file: File): Promise<UploadResponse> {
    const fd = new FormData();
    fd.append("file", file);
    return request<UploadResponse>(`/api/sessions/${enc(sessionId)}/upload`, {
      method: "POST",
      rawBody: fd,
    });
  },
  /**
   * XHR-backed upload that surfaces 0–1 progress fractions. The auth
   * token is attached as a header so the upload still passes the auth
   * middleware; if it's empty (loopback) the header is omitted.
   */
  withProgress(
    sessionId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<UploadResponse> {
    return new Promise((resolveP, rejectP) => {
      const fd = new FormData();
      fd.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/api/sessions/${enc(sessionId)}/upload`);
      const tok = getToken();
      if (tok) xhr.setRequestHeader("X-Bridge-Internal-Token", tok);
      xhr.upload.addEventListener("progress", (ev) => {
        if (!ev.lengthComputable) return;
        onProgress(Math.min(1, ev.loaded / ev.total));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolveP(JSON.parse(xhr.responseText) as UploadResponse);
          } catch (e) {
            rejectP(e);
          }
        } else {
          rejectP(
            new ApiError(
              xhr.status,
              xhr.responseText || xhr.statusText || "upload failed",
            ),
          );
        }
      });
      xhr.addEventListener("error", () =>
        rejectP(new ApiError(0, "network error")),
      );
      xhr.addEventListener("abort", () => rejectP(new ApiError(0, "aborted")));
      xhr.send(fd);
    });
  },
  /** Convenience: build the GET URL for a previously-staged upload. */
  fileUrl(sessionId: string, name: string): string {
    return `${API_BASE}/api/uploads/${enc(sessionId)}/${enc(name)}`;
  },
};

// ---- misc / bridge / usage ---------------------------------------------

const bridge = {
  /** GET /api/bridge/settings. */
  settings(opts?: { signal?: AbortSignal }): Promise<BridgeSettings> {
    return request<BridgeSettings>("/api/bridge/settings", {
      signal: opts?.signal,
    });
  },
  /** PUT /api/bridge/settings — rewrites bridge.json. */
  updateSettings(patch: BridgeSettings): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>("/api/bridge/settings", {
      method: "PUT",
      body: patch,
    });
  },
};

// ---- typed wrappers ------------------------------------------------------

export const api = {
  // domain blocks
  tasks,
  sessions,
  apps,
  repos,
  tunnels,
  permission,
  uploads,
  bridge,

  // health
  health(opts?: { silentAuth?: boolean; signal?: AbortSignal }): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health", {
      silentAuth: opts?.silentAuth,
      signal: opts?.signal,
    });
  },

  // usage
  usage(force = false, opts?: { signal?: AbortSignal }): Promise<UsageResponse> {
    return request<UsageResponse>(force ? "/api/usage?force=1" : "/api/usage", {
      signal: opts?.signal,
    });
  },

  // ---- legacy flat aliases ----------------------------------------------
  // The dashboard pages were written against the v0.1 client. These
  // aliases keep them building while we migrate callers to the
  // domain-grouped form above.

  listTasksMeta(): Promise<TaskMetaList> {
    // Map the canonical {[id]: Meta} response onto the legacy `{tasks: []}`
    // shape so the existing dashboard kanban / sidebar keep working.
    return tasks.meta().then((m) => ({ tasks: Object.values(m) }));
  },
  getTask(id: string): Promise<TaskMeta> {
    return tasks.getMeta(id);
  },
  getTaskSummary(id: string): Promise<string> {
    return tasks.summary(id).then((r) => r.summary);
  },
  createTask(body: { title: string; body: string; app?: string }) {
    return tasks.create(body);
  },
  patchTask(id: string, body: PatchTaskBody) {
    return tasks.patch(id, body);
  },
  deleteTask(id: string): Promise<DeleteTaskResponse> {
    return tasks.delete(id);
  },
  spawnAgent(
    id: string,
    body: { role: string; repo?: string; prompt?: string; parentSessionId?: string },
  ) {
    return tasks.spawnAgent(id, {
      role: body.role,
      repo: body.repo ?? "",
      prompt: body.prompt ?? "",
      parentSessionId: body.parentSessionId,
    });
  },
  continueTask(id: string, body?: { prompt?: string }) {
    return tasks.continue(id, body);
  },
  clearTask(id: string) {
    return tasks.clear(id);
  },
  // Legacy `appsList()` returned the AppsResponse directly. Preserved
  // here under a non-conflicting name; the v0.1 `api.apps()` callers
  // are migrated to `api.apps.list()` in queries.ts.
  appsList(): Promise<AppsResponse> {
    return apps.list();
  },

  // Settings access for rest of the app — kept as a method to mirror
  // the v0.1 surface.
  bridgeSettings(opts?: { signal?: AbortSignal }) {
    return bridge.settings(opts);
  },
  updateBridgeSettings(patch: BridgeSettings) {
    return bridge.updateSettings(patch);
  },
};

export { API_BASE, request };

/** Re-exported so SSE-side callers can attach the same auth strategy. */
export const auth = {
  getToken,
  setToken,
};
