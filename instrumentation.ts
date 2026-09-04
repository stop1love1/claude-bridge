
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { logWarn } = await import("./libs/log");

  const { runStartupChecks } = await import("./libs/startupChecks");
  void runStartupChecks().catch((err: unknown) => {
    logWarn("startup", "startup checks failed", { error: (err as Error).message });
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
    logWarn("tunnels", "auto-start failed", { error: (err as Error).message });
  });
}
