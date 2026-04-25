import { resolve, join, basename } from "node:path";

/**
 * The Next app now lives at the bridge repo root (no separate `ui/`
 * sub-dir), so `process.cwd()` *is* the bridge root.
 */
export const BRIDGE_ROOT = resolve(process.cwd());
/**
 * Folder name of the bridge itself (the directory `BRIDGE_ROOT` points
 * at). Substituted into prompt templates so children write their
 * reports back via `../<BRIDGE_FOLDER>/sessions/...` regardless of what
 * the bridge directory is actually named — no hardcoded project name.
 */
export const BRIDGE_FOLDER = basename(BRIDGE_ROOT);
export const BRIDGE_MD = join(BRIDGE_ROOT, "BRIDGE.md");
export const SESSIONS_DIR = join(BRIDGE_ROOT, "sessions");

/**
 * All bridge-runtime markdown lives here:
 *   - `coordinator.md`     — the coordinator prompt template
 *   - `report-template.md` — the child agent report contract
 *   - `bugs.md`, `decisions.md`, `questions.md`, `schema.md` —
 *     cross-repo registers the coordinator reads / writes
 *   - `tasks.md`           — legacy notebook (no longer runtime data)
 */
export const BRIDGE_LOGIC_DIR = join(BRIDGE_ROOT, "bridge");

/**
 * Where standalone Node hook scripts live. The bridge writes a
 * per-spawn settings JSON that points `claude --settings` at the
 * `permission-hook.cjs` script in this directory. Kept separate from
 * `BRIDGE_LOGIC_DIR` because hooks are executable JS, not markdown.
 */
export const HOOKS_DIR = join(BRIDGE_ROOT, "agents");

/**
 * @deprecated Use `BRIDGE_LOGIC_DIR` for markdown templates and
 * `HOOKS_DIR` for `permission-hook.cjs`. Kept as an alias so older
 * callers don't break during the migration.
 */
export const AGENTS_DIR = BRIDGE_LOGIC_DIR;

/**
 * Scratch dir for bridge-managed runtime state per free (non-task)
 * session: per-session `--settings <path>` JSON, anything else internal
 * the bridge generates that ISN'T a user-uploaded chat attachment.
 *
 * Phase C: split off from `.uploads/` (which is for user-uploaded chat
 * attachments — different concern). Gitignored via `.bridge-state/`.
 */
export const BRIDGE_STATE_DIR = join(BRIDGE_ROOT, ".bridge-state");

/**
 * Port the bridge listens on. Read from BRIDGE_PORT first (legacy /
 * permission-hook precedent), then PORT (the Next.js convention used
 * inside Docker), falling back to 7777 — the documented default in
 * CLAUDE.md / BRIDGE.md.
 *
 * Spawned children call the bridge back over HTTP (self-register, agent
 * spawn, task patch); they need the SAME port. `lib/spawn.ts` injects
 * `BRIDGE_PORT` into every child's env so the hook scripts and the
 * coordinator template both see the right value, regardless of which
 * variable the operator originally set.
 */
export const BRIDGE_PORT = Number(
  process.env.BRIDGE_PORT ?? process.env.PORT ?? 7777,
);

/**
 * Full origin a sub-process / hook should hit to reach the bridge API.
 * Override the host portion via BRIDGE_URL (useful for non-localhost
 * deployments behind a reverse proxy); otherwise we synthesise
 * `http://localhost:<port>` so prompts and curl examples render the
 * actual port the user started the bridge on.
 */
export const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://localhost:${BRIDGE_PORT}`;
