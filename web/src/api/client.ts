// Thin REST client for the bridge backend. Reads the operator's
// internal token from localStorage and attaches it to every request as
// `X-Bridge-Internal-Token`. When the bridge runs with --localhost-only
// the loopback connection bypasses auth and the token may be empty.
//
// On a 401 we redirect to /settings?reason=auth so the operator can
// paste a fresh token without losing their place.

import type {
  AppsResponse,
  HealthResponse,
  TaskMeta,
  TaskMetaList,
  UsageResponse,
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
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const token = getToken();
  if (token) headers["x-bridge-internal-token"] = token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

// ---- typed wrappers ------------------------------------------------------

export const api = {
  health(opts?: { silentAuth?: boolean }): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health", { silentAuth: opts?.silentAuth });
  },

  listTasksMeta(): Promise<TaskMetaList> {
    return request<TaskMetaList>("/api/tasks/meta");
  },

  getTask(id: string): Promise<TaskMeta> {
    return request<TaskMeta>(`/api/tasks/${encodeURIComponent(id)}/meta`);
  },

  getTaskSummary(id: string): Promise<string> {
    return request<string>(`/api/tasks/${encodeURIComponent(id)}/summary`);
  },

  createTask(body: {
    title: string;
    body: string;
    app?: string;
  }): Promise<TaskMeta> {
    return request<TaskMeta>("/api/tasks", { method: "POST", body });
  },

  patchTask(
    id: string,
    body: Partial<{
      title: string;
      body: string;
      section: string;
      checked: boolean;
    }>,
  ): Promise<TaskMeta> {
    return request<TaskMeta>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    });
  },

  deleteTask(id: string): Promise<void> {
    return request<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  spawnAgent(
    id: string,
    body: { role: string; repo?: string; prompt?: string },
  ): Promise<unknown> {
    return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/agents`, {
      method: "POST",
      body,
    });
  },

  continueTask(id: string, body?: { prompt?: string }): Promise<unknown> {
    return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/continue`, {
      method: "POST",
      body: body ?? {},
    });
  },

  clearTask(id: string): Promise<unknown> {
    return request<unknown>(`/api/tasks/${encodeURIComponent(id)}/clear`, {
      method: "POST",
      body: {},
    });
  },

  apps(): Promise<AppsResponse> {
    return request<AppsResponse>("/api/apps");
  },

  usage(): Promise<UsageResponse> {
    return request<UsageResponse>("/api/usage");
  },
};

export { API_BASE };
