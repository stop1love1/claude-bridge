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
import type { TaskMeta } from "@/api/types";

export const qk = {
  health: ["health"] as const,
  tasksMeta: ["tasks", "meta"] as const,
  task: (id: string) => ["task", id] as const,
  taskSummary: (id: string) => ["task", id, "summary"] as const,
  apps: ["apps"] as const,
  usage: ["usage"] as const,
};

export function useHealth(refetchMs = 10_000) {
  return useQuery({
    queryKey: qk.health,
    queryFn: () => api.health({ silentAuth: true }),
    refetchInterval: refetchMs,
    retry: 0,
  });
}

export function useTasksMeta(refetchMs = 5_000) {
  return useQuery({
    queryKey: qk.tasksMeta,
    queryFn: () => api.listTasksMeta(),
    refetchInterval: refetchMs,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.task(id) : ["task", "<unset>"],
    queryFn: () => api.getTask(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });
}

export function useTaskSummary(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.taskSummary(id) : ["task", "<unset>", "summary"],
    queryFn: () => api.getTaskSummary(id as string),
    enabled: !!id,
    retry: 0,
  });
}

export function useApps() {
  return useQuery({ queryKey: qk.apps, queryFn: () => api.apps() });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; body: string; app?: string }) =>
      api.createTask(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasksMeta }),
  });
}

export function usePatchTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<{
        title: string;
        body: string;
        section: string;
        checked: boolean;
      }>;
    }) => api.patchTask(id, patch),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.tasksMeta });
      qc.invalidateQueries({ queryKey: qk.task(vars.id) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasksMeta }),
  });
}

export function useSpawnAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { role: string; repo?: string; prompt?: string }) =>
      api.spawnAgent(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.task(id) }),
  });
}

export function useContinueTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { prompt?: string }) => api.continueTask(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.task(id) }),
  });
}

export function useClearTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.task(id) }),
  });
}

export function invalidateTask(qc: QueryClient, id: string) {
  qc.invalidateQueries({ queryKey: qk.task(id) });
  qc.invalidateQueries({ queryKey: qk.tasksMeta });
}

// Helper: optimistic patch into tasksMeta cache so kanban-drag (future)
// or "+ New task" reflects state without waiting for the next poll.
export function patchTasksMetaCache(
  qc: QueryClient,
  next: (tasks: TaskMeta[]) => TaskMeta[],
) {
  qc.setQueryData<{ tasks: TaskMeta[] }>(qk.tasksMeta, (prev) =>
    prev ? { tasks: next(prev.tasks) } : prev,
  );
}
