# Running Claude Bridge 24/7 (Windows)

The **Workflows** feature (cron + auto-queue) is only useful while the bridge
process stays alive. The bridge can't resurrect itself if the process dies —
that's the job of an OS-level supervisor. On Windows, the simplest option (no
extra install) is **Windows Task Scheduler**.

## Quick install (Task Scheduler — recommended)

Open PowerShell in the bridge folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

The script registers a task named `ClaudeBridge`:

- **Trigger:** starts when you log on to Windows (`AtLogOn`).
- **Auto-restart:** if the process exits/crashes, Task Scheduler restarts it
  every minute (up to 999 times) — i.e. "always alive".
- **Single instance:** `MultipleInstances IgnoreNew` plus the bridge's advisory
  process lock guarantees two bridges never write to `sessions/` at once.
- **Logs:** stdout/stderr are appended to `.bridge-state\bridge-service.log`.

Start it now (no need to log off/on):

```powershell
Start-ScheduledTask -TaskName ClaudeBridge
```

Check status:

```powershell
Get-ScheduledTask -TaskName ClaudeBridge | Get-ScheduledTaskInfo
```

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
```

> Note: `AtLogOn` requires your login session to be open. If you need the bridge
> to run even when nobody is logged in (a headless server), use NSSM below to
> run it as a real Windows Service.

## Optional: NSSM (a real Windows Service)

NSSM runs the bridge as a service independent of a login session, with its own
log stream.

1. Download nssm: <https://nssm.cc/download> and put `nssm.exe` on PATH.
2. Create the service (adjust the `bun` path and bridge folder to match yours):

   ```powershell
   $bun = (Get-Command bun).Source
   nssm install ClaudeBridge "$bun" "run start"
   nssm set ClaudeBridge AppDirectory "D:\Edusoft\lms.edusoft.vn\claude-bridge"
   nssm set ClaudeBridge AppStdout "D:\Edusoft\lms.edusoft.vn\claude-bridge\.bridge-state\bridge-service.log"
   nssm set ClaudeBridge AppStderr "D:\Edusoft\lms.edusoft.vn\claude-bridge\.bridge-state\bridge-service.log"
   nssm set ClaudeBridge Start SERVICE_AUTO_START
   nssm start ClaudeBridge
   ```

3. Remove: `nssm stop ClaudeBridge; nssm remove ClaudeBridge confirm`.

## After installing

- Open **Workflows** in the UI to see the **24/7 status** panel (PID, uptime,
  last tick), toggle **auto-queue** + set the **concurrency cap**, and create
  **cron** schedules.
- The scheduler only ticks on the process that holds the advisory lock, so even
  if Task Scheduler accidentally launches two copies it won't double-dispatch.
- Every task created by the scheduler/cron stops at **READY FOR REVIEW** — it
  never auto-marks DONE; you remain the reviewer.

## Time-of-day schedules and timezones

`daily at HH:MM` schedules are interpreted in the **server's local timezone**.
On timezones that observe DST, a time that falls in the spring-forward gap
(e.g. `02:30` where 02:00→03:00 is skipped) is shifted by the OS and will fire
at the adjusted wall-clock time. Pick a time outside the DST gap if your machine
observes daylight saving.
