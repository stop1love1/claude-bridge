import { updateRun, type Run } from "./meta";

export interface ClaimRunForResumeResult {
  ok: boolean;
  run: Run | null;
}

export async function claimRunForResume(
  dir: string,
  sessionId: string,
  extraPatch: Partial<Run> = {},
): Promise<ClaimRunForResumeResult> {
  const result = await updateRun(
    dir,
    sessionId,
    {
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      ...extraPatch,
    },
    (run) => run.status !== "running" && run.status !== "queued",
  );
  return { ok: result.applied, run: result.run };
}
