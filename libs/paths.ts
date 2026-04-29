import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

/**
 * The Next app now lives at the bridge repo root (no separate `ui/`
 * sub-dir), so `process.cwd()` *is* the bridge root.
 *
 * The `turbopackIgnore` hint stops Turbopack from treating this `cwd()`
 * as a dynamic import path and pulling the entire project into the NFT
 * (Node File Trace) bundle for every API route that transitively imports
 * `libs/paths.ts`. Without it, builds emit a noisy "whole project was
 * traced unintentionally" warning even though we never use these
 * constants as import targets — they're just runtime FS paths.
 */
export const BRIDGE_ROOT = resolve(/* turbopackIgnore: true */ process.cwd());
/**
 * Folder name of the bridge itself (the directory `BRIDGE_ROOT` points
 * at). Substituted into prompt templates so children write their
 * reports back via `../<BRIDGE_FOLDER>/sessions/...` regardless of what
 * the bridge directory is actually named — no hardcoded project name.
 */
export const BRIDGE_FOLDER = basename(BRIDGE_ROOT);
export const BRIDGE_MD = join(BRIDGE_ROOT, "BRIDGE.md");

/**
 * Read BRIDGE.md, tolerating its absence — a fresh checkout, deletion,
 * or path-rename should never crash a route. Every call site that used
 * to do `readFileSync(BRIDGE_MD)` now goes through this so the empty-
 * fallback semantic is consistent project-wide.
 */
export function readBridgeMd(): string {
  try {
    return readFileSync(BRIDGE_MD, "utf8");
  } catch {
    return "";
  }
}
export const SESSIONS_DIR = join(BRIDGE_ROOT, "sessions");

/**
 * All bridge-runtime markdown lives here:
 *   - `coordinator.md`           — the coordinator KERNEL prompt template
 *                                  (short, with `{{TASK_ID}}` / `{{SESSION_ID}}` /
 *                                  `{{BRIDGE_URL}}` / `{{BRIDGE_FOLDER}}` substituted
 *                                  at spawn time)
 *   - `coordinator-playbook.md`  — static reference manual the coordinator `Read`s
 *                                  on demand (recipe table, error codes, NEEDS-DECISION
 *                                  procedure, hard rules). Not substituted; the kernel
 *                                  tells the coordinator to mentally substitute its
 *                                  template markers from the kernel.
 *   - `report-template.md`       — the child agent report contract
 *   - `bugs.md`, `decisions.md`, `questions.md` —
 *                                  cross-repo registers the coordinator reads / writes
 *   - `tasks.md`                 — legacy notebook (no longer runtime data)
 */
export const BRIDGE_LOGIC_DIR = join(BRIDGE_ROOT, "prompts");

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
 * Project-local `.claude/` directory (Claude Code's per-repo config:
 * `settings.json`, `settings.local.json`).
 */
export const CLAUDE_DIR = join(BRIDGE_ROOT, ".claude");

/**
 * Claude Code's GLOBAL user config directory under `$HOME`. The bridge
 * stores its own `bridge.json` (apps registry + future settings) here
 * so the file lives **outside** the bridge project and survives every
 * upstream `git pull` / version upgrade. One registry per machine,
 * not per project; if the operator runs multiple bridge installs they
 * share the same apps roster.
 *
 * `turbopackIgnore` for the same NFT-trace reason as `BRIDGE_ROOT`
 * above — `homedir()` is a runtime FS path, never a module specifier.
 */
export const USER_CLAUDE_DIR = join(/* turbopackIgnore: true */ homedir(), ".claude");

/**
 * Port the bridge listens on. Read from BRIDGE_PORT first (legacy /
 * permission-hook precedent), then PORT (the standard Next.js
 * convention), falling back to 7777 — the documented default in
 * CLAUDE.md / BRIDGE.md.
 *
 * Spawned children call the bridge back over HTTP (self-register, agent
 * spawn, task patch); they need the SAME port. `libs/spawn.ts` injects
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
 *
 * NOTE: this constant is what spawned children call back over — keep it
 * pointing at the LOCAL origin (env override is fine; UI-configured
 * public URL is NOT applied here, since the child needs to hit the
 * loopback interface even when the operator has a public domain
 * fronting the bridge).
 */
export const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://localhost:${BRIDGE_PORT}`;

/**
 * Resolve the URL to use when rendering links the OPERATOR (or someone
 * they share with) will click — Telegram task links, magic-link emails,
 * webhook payloads. Distinct from `BRIDGE_URL` because:
 *
 *   - `BRIDGE_URL` is the address spawned children use to talk back to
 *     the bridge; it must stay loopback-reachable.
 *   - This is the address a human's browser opens; it should be the
 *     publicly-routable domain when one is configured.
 *
 * Resolution order (first non-empty wins):
 *   1. `BRIDGE_PUBLIC_URL` env — explicit operator override at boot.
 *   2. `bridge.json#publicUrl` — UI-configured value (the typical path).
 *   3. `BRIDGE_URL` env — same override the children use; fine for a
 *      single-host install with no separate public domain.
 *   4. `bridge.json#runtime.url` — auto-written at startup, always
 *      `http://localhost:<port>`. Last-resort fallback.
 *
 * Lazy-imported `getManifestPublicUrl` to avoid a circular dep
 * (`libs/apps.ts` doesn't import paths.ts at module load, but the
 * Telegram notifier paths through both).
 */
export function getPublicBridgeUrl(): string {
  const envExplicit = process.env.BRIDGE_PUBLIC_URL?.trim();
  if (envExplicit) return stripTrailingSlash(envExplicit);
  // Lazy require so this module stays cheap to import — `libs/apps.ts`
  // pulls in fs / JSON parsing that not every caller needs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getManifestPublicUrl } = require("./apps") as {
      getManifestPublicUrl: () => string;
    };
    const fromManifest = getManifestPublicUrl();
    if (fromManifest) return stripTrailingSlash(fromManifest);
  } catch {
    /* ignore — apps module unavailable in some test contexts */
  }
  if (process.env.BRIDGE_URL) return stripTrailingSlash(process.env.BRIDGE_URL);
  return stripTrailingSlash(BRIDGE_URL);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
