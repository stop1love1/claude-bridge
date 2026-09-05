import { resolveRole } from "./roleRegistry";
import { isValidModel } from "./validate";
import { ROLE_MODELS_WILDCARD, type AppRoleModels } from "./apps/types";

export interface ResolveModelOpts {
  /** Explicit pin on this one dispatch (`POST /api/tasks/<id>/agents` body). */
  requested?: string | null;
  /** The target app's manifest entry, when the repo is a registered app. */
  app?: { roleModels?: AppRoleModels } | null;
  /** The child's role label — `coder-api`, `reviewer-2`, `coordinator`, … */
  role: string;
  /** The task-level pin from `meta.taskModel`. */
  taskModel?: string | null;
}

/**
 * Picks the `--model` a run should be spawned with.
 *
 * Priority, most specific first:
 *   1. `requested`             — this dispatch asked for a model outright
 *   2. `app.roleModels[role]`  — the app pins this role (matched on the *base*
 *                                role, so `coder-api` inherits `coder`)
 *   3. `app.roleModels["*"]`   — the app pins every role
 *   4. `taskModel`             — the task pins every run under it
 *   5. `undefined`             — no pin
 *
 * `undefined` is the load-bearing return: it means "do not pass `--model` at
 * all", which is what every dispatch did before model pinning existed. Invalid
 * values at any level are skipped rather than throwing, so one bad entry in
 * `bridge.json` degrades to the next source instead of breaking dispatch.
 */
export function resolveModelForRun(opts: ResolveModelOpts): string | undefined {
  if (isValidModel(opts.requested)) return opts.requested;

  const roleModels = opts.app?.roleModels;
  if (roleModels) {
    const baseRole = resolveRole(opts.role).name;
    const byRole = roleModels[baseRole];
    if (isValidModel(byRole)) return byRole;
    const wildcard = roleModels[ROLE_MODELS_WILDCARD];
    if (isValidModel(wildcard)) return wildcard;
  }

  if (isValidModel(opts.taskModel)) return opts.taskModel;
  return undefined;
}

export interface ResolveContinuationOpts extends ResolveModelOpts {
  /** `Run.model` — the model the session was actually spawned with. */
  priorModel?: string | null;
}

/**
 * Picks the `--model` for a *continuation* of an existing session — a resume,
 * a gate retry, a nudge, a chat message into a live run.
 *
 * The rule is one line: a continuation re-pins whatever the run was spawned
 * with, unless this call explicitly asks for something else. Without that,
 * a task pinned to `opus` would quietly finish on the CLI default the first
 * time a gate retried it, or the first time the operator's app config changed
 * mid-task — the model would drift underneath a half-written diff.
 */
export function resolveModelForContinuation(
  opts: ResolveContinuationOpts,
): string | undefined {
  if (isValidModel(opts.requested)) return opts.requested;
  if (isValidModel(opts.priorModel)) return opts.priorModel;
  return resolveModelForRun({ ...opts, requested: undefined });
}
