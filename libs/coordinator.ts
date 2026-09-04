import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BRIDGE_FOLDER, BRIDGE_LOGIC_DIR, BRIDGE_ROOT, BRIDGE_URL, SESSIONS_DIR, readBridgeMd } from "./paths";
import { appendRun, readMeta, updateRun } from "./meta";
import { sanitizeUserPromptContent } from "./childPrompt";
import { spawnClaude } from "./spawn";
import type { Task } from "./tasks";
import { loadProfiles } from "./profileStore";
import { resolveRepos } from "./repos";
import {
  getOrComputeScope,
  loadDetectInput,
  renderDetectedScope,
} from "./detect";
import { buildTeamHint } from "./teamHints";

export { wireRunLifecycle } from "./runLifecycle";
import { wireRunLifecycle } from "./runLifecycle";
import { logError } from "./log";

async function buildDetectedScopeBlock(
  sessionsDir: string,
  task: Pick<Task, "id" | "title" | "body" | "app">,
): Promise<string> {
  try {
    const profiles = loadProfiles()?.profiles ?? undefined;
    const scope = await getOrComputeScope(sessionsDir, () =>
      loadDetectInput({
        taskBody: task.body,
        taskTitle: task.title,
        pinnedRepo: task.app ?? null,
      }),
    );
    const scopeBlock = renderDetectedScope(scope, {
      profiles,
      forCoordinator: true,
    });
    const hint = buildTeamHint({
      taskBody: task.body,
      detectedScope: scope,
      profiles,
    });
    return hint ? `${scopeBlock}\n${hint.block}` : scopeBlock;
  } catch (err) {
    logError("coordinator", "buildDetectedScopeBlock failed (non-fatal)", err);
    return [
      "## Detected scope",
      "",
      "_(detection layer crashed — see bridge logs. Fall back to reading the task body and BRIDGE.md repos table directly.)_",
      "",
    ].join("\n");
  }
}

function spliceScopeBlock(rendered: string, block: string): string {
  const marker = "## Your job";
  const idx = rendered.indexOf(marker);
  if (idx === -1) return `${block}\n${rendered}`;
  return `${rendered.slice(0, idx)}${block}\n${rendered.slice(idx)}`;
}

export async function spawnCoordinatorForTask(
  task: Pick<Task, "id" | "title" | "body"> & {
    app?: string | null;
    effort?: Task["effort"];
  },
): Promise<string | null> {
  const sessionsDir = join(SESSIONS_DIR, task.id);

  if (!readMeta(sessionsDir)) {
    logError("coordinator", "coordinator spawn skipped: meta.json missing", undefined, { taskId: task.id });
    return null;
  }

  try {
    const sessionId = randomUUID();

    const template = readFileSync(join(BRIDGE_LOGIC_DIR, "coordinator.md"), "utf8");
    let exampleRepo = BRIDGE_FOLDER;
    try {
      const md = readBridgeMd();
      const declared = resolveRepos(md, BRIDGE_ROOT)
        .filter((r) => existsSync(r.path))
        .map((r) => r.name);
      if (declared.length > 0) exampleRepo = declared[0];
    } catch {
    }

    const safeTitle = sanitizeUserPromptContent(task.title);
    const safeBody = sanitizeUserPromptContent(task.body);
    const baseRendered = template
      .replaceAll("{{SESSION_ID}}", sessionId)
      .replaceAll("{{BRIDGE_URL}}", BRIDGE_URL)
      .replaceAll("{{BRIDGE_FOLDER}}", BRIDGE_FOLDER)
      .replaceAll("{{EXAMPLE_REPO}}", exampleRepo)
      .replaceAll("{{TASK_ID}}", task.id);
    const scopeBlock = await buildDetectedScopeBlock(sessionsDir, {
      id: task.id,
      title: task.title,
      body: task.body,
      app: task.app ?? null,
    });
    const splicedTemplate = spliceScopeBlock(baseRendered, scopeBlock);
    const renderedPrompt = splicedTemplate
      .replaceAll("{{TASK_TITLE}}", safeTitle)
      .replaceAll("{{TASK_BODY}}", safeBody);

    await appendRun(sessionsDir, {
      sessionId,
      role: "coordinator",
      repo: basename(BRIDGE_ROOT),
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    let child;
    try {
      ({ child } = spawnClaude(BRIDGE_ROOT, {
        role: "coordinator",
        taskId: task.id,
        prompt: renderedPrompt,
        sessionId,
        settings: {
          mode: "bypassPermissions",
          disallowedTools: ["Task"],
          effort: task.effort ?? undefined,
        },
      }));
    } catch (spawnErr) {
      try {
        await updateRun(sessionsDir, sessionId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      } catch (uErr) {
        logError("coordinator", "failed to mark coordinator run failed after spawn error", uErr);
      }
      throw spawnErr;
    }

    try {
      await updateRun(sessionsDir, sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    } catch (uErr) {
      logError("coordinator", "failed to promote coordinator queued → running", uErr);
    }

    wireRunLifecycle(sessionsDir, sessionId, child, basename(BRIDGE_ROOT), `coordinator ${task.id}`);
    return sessionId;
  } catch (err) {
    logError("coordinator", "coordinator spawn failed", err, { taskId: task.id });
    return null;
  }
}
