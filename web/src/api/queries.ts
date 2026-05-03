// React-Query hooks. Keys live here so cache invalidations from SSE
// handlers (see api/sse.ts) and from mutation success callbacks stay
// in sync with the queries that read them.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  AddAppBody,
  AgentSpawnBody,
  AnswerPermissionBody,
  AppendAppMemoryBody,
  BridgeSettings,
  BulkAddAppEntry,
  CreateTaskBody,
  CreateTunnelBody,
  LinkSessionBody,
  PatchTaskBody,
  PermissionRequest,
  SessionMessageBody,
  SessionRewindBody,
  TaskMeta,
  TaskMetaMap,
  TunnelEntry,
} from "@/api/types";

export const qk = {
  health: ["health"] as const,
  tasks: ["tasks"] as const,
  tasksMeta: ["tasks", "meta"] as const,
  task: (id: string) => ["task", id] as const,
  taskMeta: (id: string) => ["task", id, "meta"] as const,
  taskSummary: (id: string) => ["task", id, "summary"] as const,
  taskUsage: (id: string) => ["task", id, "usage"] as const,
  runPrompt: (taskId: string, sid: string) =>
    ["task", taskId, "run", sid, "prompt"] as const,
  runDiff: (taskId: string, sid: string) =>
    ["task", taskId, "run", sid, "diff"] as const,

  apps: ["apps"] as const,
  app: (name: string) => ["apps", name] as const,
  appMemory: (name: string) => ["apps", name, "memory"] as const,

  repos: ["repos"] as const,
  repo: (name: string) => ["repos", name] as const,
  repoFiles: (name: string, path?: string) =>
    ["repos", name, "files", path ?? ""] as const,
  repoSlash: (name: string) => ["repos", name, "slash"] as const,
  repoProfiles: ["repos", "profiles"] as const,
  repoProfile: (name: string) => ["repos", "profiles", name] as const,

  sessions: ["sessions"] as const,
  sessionTail: (sid: string, repo: string, since: number) =>
    ["sessions", sid, "tail", repo, since] as const,

  tunnels: ["tunnels"] as const,
  tunnelProviders: ["tunnels", "providers"] as const,

  permissions: ["permissions"] as const,
  sessionPermissions: (sid: string) => ["sessions", sid, "permissions"] as const,

  bridgeSettings: ["bridge", "settings"] as const,
  usage: ["usage"] as const,
};

// ---- queries ------------------------------------------------------------

export function useHealth(refetchMs = 10_000) {
  return useQuery({
    queryKey: qk.health,
    queryFn: () => api.health({ silentAuth: true }),
    refetchInterval: refetchMs,
    retry: 0,
  });
}

export function useTasks(refetchMs = 5_000) {
  return useQuery({
    queryKey: qk.tasks,
    queryFn: ({ signal }) => api.tasks.list({ signal }),
    refetchInterval: refetchMs,
  });
}

/**
 * Returns the legacy `{tasks: TaskMeta[]}` envelope. The Go bridge
 * emits a record-keyed map; we project to an array here so existing
 * dashboard pages (Board, HeaderShell, …) keep their `data?.tasks`
 * access pattern. Callers that want the keyed map should use
 * {@link useTasksMetaMap}.
 */
export function useTasksMeta(refetchMs = 5_000) {
  return useQuery<{ tasks: TaskMeta[] }>({
    queryKey: qk.tasksMeta,
    queryFn: ({ signal }) =>
      api.tasks.meta({ signal }).then((m) => ({ tasks: Object.values(m) })),
    refetchInterval: refetchMs,
  });
}

/** Same data, record-keyed (`{ [taskId]: Meta }`). */
export function useTasksMetaMap(refetchMs = 5_000) {
  return useQuery<TaskMetaMap>({
    queryKey: [...qk.tasksMeta, "map"] as const,
    queryFn: ({ signal }) => api.tasks.meta({ signal }),
    refetchInterval: refetchMs,
  });
}

export function useTaskMeta(id: string | undefined) {
  return useQuery<TaskMeta>({
    queryKey: id ? qk.taskMeta(id) : ["task", "<unset>", "meta"],
    queryFn: () => api.tasks.getMeta(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });
}

/** Legacy alias the existing pages call. Prefer useTaskMeta in new code. */
export function useTask(id: string | undefined) {
  return useTaskMeta(id);
}

export function useTaskSummary(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.taskSummary(id) : ["task", "<unset>", "summary"],
    queryFn: () => api.tasks.summary(id as string).then((r) => r.summary),
    enabled: !!id,
    retry: 0,
  });
}

export function useTaskUsage(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.taskUsage(id) : ["task", "<unset>", "usage"],
    queryFn: ({ signal }) => api.tasks.usage(id as string, { signal }),
    enabled: !!id,
  });
}

export function useRunDiff(taskId: string | undefined, sid: string | undefined) {
  return useQuery({
    queryKey:
      taskId && sid ? qk.runDiff(taskId, sid) : ["task", "<unset>", "run", "<unset>", "diff"],
    queryFn: ({ signal }) =>
      api.tasks.runDiff(taskId as string, sid as string, { signal }),
    enabled: !!taskId && !!sid,
  });
}

export function useApps(refetchMs = 30_000) {
  return useQuery({
    queryKey: qk.apps,
    queryFn: ({ signal }) => api.apps.list({ signal }),
    refetchInterval: refetchMs,
  });
}

export function useApp(name: string | undefined) {
  return useQuery({
    queryKey: name ? qk.app(name) : ["apps", "<unset>"],
    queryFn: () => api.apps.get(name as string),
    enabled: !!name,
  });
}

export function useAppMemory(name: string | undefined) {
  return useQuery({
    queryKey: name ? qk.appMemory(name) : ["apps", "<unset>", "memory"],
    queryFn: () => api.apps.memory(name as string),
    enabled: !!name,
  });
}

export function useRepos(refetchMs = 30_000) {
  return useQuery({
    queryKey: qk.repos,
    queryFn: ({ signal }) => api.repos.list({ signal }),
    refetchInterval: refetchMs,
  });
}

export function useRepoFiles(name: string | undefined, path?: string) {
  return useQuery({
    queryKey: name
      ? qk.repoFiles(name, path)
      : ["repos", "<unset>", "files", ""],
    queryFn: ({ signal }) => api.repos.files(name as string, path, { signal }),
    enabled: !!name,
  });
}

export function useRepoSlashCommands(name: string | undefined) {
  return useQuery({
    queryKey: name ? qk.repoSlash(name) : ["repos", "<unset>", "slash"],
    queryFn: ({ signal }) =>
      api.repos.slashCommands(name as string, { signal }),
    enabled: !!name,
  });
}

export function useRepoProfiles() {
  return useQuery({
    queryKey: qk.repoProfiles,
    queryFn: ({ signal }) => api.repos.profiles({ signal }),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: ({ signal }) => api.sessions.all({ signal }),
  });
}

export function useSessionTail(
  sessionId: string | undefined,
  repo: string | undefined,
  since: number,
) {
  return useQuery({
    queryKey:
      sessionId && repo
        ? qk.sessionTail(sessionId, repo, since)
        : ["sessions", "<unset>", "tail", "", 0],
    queryFn: ({ signal }) =>
      api.sessions.tail(sessionId as string, repo as string, since, { signal }),
    enabled: !!sessionId && !!repo,
  });
}

/**
 * Tunnel polling cadence flexes — when any tunnel is in `starting`
 * state we tighten to 1 s so the operator sees the URL appear quickly,
 * otherwise we relax to 5 s.
 */
export function useTunnels() {
  return useQuery({
    queryKey: qk.tunnels,
    queryFn: ({ signal }) => api.tunnels.list({ signal }),
    refetchInterval: (q) => {
      const data = q.state.data as { tunnels: TunnelEntry[] } | undefined;
      if (!data) return 5_000;
      return data.tunnels.some((t) => t.status === "starting") ? 1_000 : 5_000;
    },
  });
}

export function useTunnelProviders() {
  return useQuery({
    queryKey: qk.tunnelProviders,
    queryFn: ({ signal }) => api.tunnels.providers({ signal }),
  });
}

/**
 * Pending-permission list. Pass a sessionId to scope, or omit for the
 * page-wide dialog. The SSE companion (see api/sse.ts) keeps this
 * fresh between manual refetches.
 */
export function usePermissions(sessionId?: string | undefined) {
  return useQuery<{ pending: PermissionRequest[] }>({
    queryKey: sessionId ? qk.sessionPermissions(sessionId) : qk.permissions,
    queryFn: ({ signal }) =>
      sessionId
        ? api.permission.forSession(sessionId, { signal })
        : api.permission.list({ signal }),
  });
}

export function useUsage(force = false) {
  return useQuery({
    queryKey: force ? [...qk.usage, "force"] : qk.usage,
    queryFn: ({ signal }) => api.usage(force, { signal }),
    // Manual refresh by default — the snapshot is expensive to compute.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

export function useBridgeSettings() {
  return useQuery({
    queryKey: qk.bridgeSettings,
    queryFn: ({ signal }) => api.bridge.settings({ signal }),
  });
}

// ---- mutations ----------------------------------------------------------

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) => api.tasks.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.tasksMeta });
    },
  });
}

export function usePatchTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchTaskBody }) =>
      api.tasks.patch(id, patch),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.tasksMeta });
      qc.invalidateQueries({ queryKey: qk.task(vars.id) });
      qc.invalidateQueries({ queryKey: qk.taskMeta(vars.id) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.tasksMeta });
    },
  });
}

export function usePutTaskSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, summary }: { id: string; summary: string }) =>
      api.tasks.putSummary(id, summary),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.taskSummary(vars.id) });
    },
  });
}

export function useSpawnAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentSpawnBody) => api.tasks.spawnAgent(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.task(id) });
      qc.invalidateQueries({ queryKey: qk.taskMeta(id) });
    },
  });
}

export function useContinueTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { prompt?: string }) => api.tasks.continue(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.task(id) });
      qc.invalidateQueries({ queryKey: qk.taskMeta(id) });
    },
  });
}

export function useClearTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.tasks.clear(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.task(id) });
      qc.invalidateQueries({ queryKey: qk.taskMeta(id) });
    },
  });
}

export function useLinkSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LinkSessionBody) => api.tasks.link(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.taskMeta(id) }),
  });
}

export function useDetectRefresh(id: string) {
  return useMutation({
    mutationFn: () => api.tasks.refreshDetect(id),
  });
}

export function useKillRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, sid }: { taskId: string; sid: string }) =>
      api.tasks.killRun(taskId, sid),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.taskMeta(vars.taskId) });
    },
  });
}

export function useKillSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.sessions.kill(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useSendSessionMessage() {
  return useMutation({
    mutationFn: ({
      sessionId,
      body,
    }: {
      sessionId: string;
      body: SessionMessageBody;
    }) => api.sessions.message(sessionId, body),
  });
}

export function useRewindSession() {
  return useMutation({
    mutationFn: ({
      sessionId,
      body,
    }: {
      sessionId: string;
      body: SessionRewindBody;
    }) => api.sessions.rewind(sessionId, body),
  });
}

// ---- apps mutations -----------------------------------------------------

export function useAddApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddAppBody) => api.apps.add(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apps }),
  });
}

export function useBulkAddApps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apps: BulkAddAppEntry[]) => api.apps.bulk(apps),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apps }),
  });
}

export function useRemoveApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.apps.remove(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apps }),
  });
}

export function useAutoDetectApps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.apps.autoDetect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apps }),
  });
}

export function useScanApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.apps.scan(name),
    onSuccess: (_d, name) => {
      qc.invalidateQueries({ queryKey: qk.app(name) });
      qc.invalidateQueries({ queryKey: qk.repoProfiles });
    },
  });
}

export function useAppendAppMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      body,
    }: {
      name: string;
      body: AppendAppMemoryBody;
    }) => api.apps.appendMemory(name, body),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: qk.appMemory(vars.name) }),
  });
}

// ---- repos mutations ----------------------------------------------------

export function useRefreshRepoProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { repo?: string }) => api.repos.refreshProfiles(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repoProfiles }),
  });
}

export function useDeleteRepoProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.repos.deleteProfile(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.repoProfiles }),
  });
}

// ---- tunnels mutations --------------------------------------------------

export function useStartTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTunnelBody) => api.tunnels.start(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tunnels }),
  });
}

export function useStopTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) =>
      api.tunnels.stop(id, purge),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tunnels }),
  });
}

export function useInstallNgrok() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.tunnels.installNgrok(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tunnelProviders }),
  });
}

export function useSetNgrokAuthtoken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.tunnels.setNgrokAuthtoken({ token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tunnelProviders }),
  });
}

// ---- permission mutations -----------------------------------------------

export function useAnswerPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      body,
    }: {
      requestId: string;
      body: AnswerPermissionBody;
    }) => api.permission.answer(requestId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.permissions }),
  });
}

export function useDecideSessionPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      requestId,
      body,
    }: {
      sessionId: string;
      requestId: string;
      body: AnswerPermissionBody;
    }) => api.permission.decideForSession(sessionId, requestId, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.permissions });
      qc.invalidateQueries({ queryKey: qk.sessionPermissions(vars.sessionId) });
    },
  });
}

// ---- bridge settings mutation ------------------------------------------

export function useUpdateBridgeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: BridgeSettings) => api.bridge.updateSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bridgeSettings }),
  });
}

// ---- helpers ------------------------------------------------------------

export function invalidateTask(qc: QueryClient, id: string) {
  qc.invalidateQueries({ queryKey: qk.task(id) });
  qc.invalidateQueries({ queryKey: qk.taskMeta(id) });
  qc.invalidateQueries({ queryKey: qk.tasks });
  qc.invalidateQueries({ queryKey: qk.tasksMeta });
}

/**
 * Optimistic patch into the meta cache (keyed by task id) so kanban
 * drags or "+ New task" reflect state without waiting for the next
 * poll. The legacy `tasksMeta` cache held a `{tasks: []}` envelope —
 * the canonical Go shape is the keyed map, so this helper now updates
 * both keys to keep call sites that haven't migrated working.
 */
export function patchTasksMetaCache(
  qc: QueryClient,
  next: (tasks: TaskMeta[]) => TaskMeta[],
) {
  // Patch the legacy `{tasks: []}` envelope cached by useTasksMeta.
  qc.setQueryData<{ tasks: TaskMeta[] }>(qk.tasksMeta, (prev) =>
    prev ? { tasks: next(prev.tasks) } : prev,
  );
  // Also patch the keyed-map cache used by useTasksMetaMap, so the
  // two stay in sync without forcing both to refetch.
  qc.setQueryData<TaskMetaMap>([...qk.tasksMeta, "map"], (prev) => {
    if (!prev) return prev;
    const arr = next(Object.values(prev));
    const out: TaskMetaMap = {};
    for (const m of arr) out[m.taskId] = m;
    return out;
  });
}
