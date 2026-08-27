
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runStartupChecks } = await import("./libs/startupChecks");
  void runStartupChecks().catch((err: unknown) => {
    console.warn("[bridge] startup checks failed:", (err as Error).message);
  });

  const { ensureTelegramNotifier } = await import("./libs/telegramNotifier");
  ensureTelegramNotifier();

  const { ensureCoordinatorNudge } = await import("./libs/coordinatorNudge");
  ensureCoordinatorNudge();

  const { ensurePipelineEngine } = await import("./libs/pipelineEngine");
  ensurePipelineEngine();
  const { ensureScheduler } = await import("./libs/scheduler");
  ensureScheduler();

  const { installShutdownHandlers } = await import("./libs/shutdownHandler");
  installShutdownHandlers();

  const { maybeAutoStartTunnel } = await import("./libs/tunnels");
  void maybeAutoStartTunnel().catch((err: unknown) => {
    console.warn("[tunnels] auto-start failed:", (err as Error).message);
  });
}
