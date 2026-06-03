<#
.SYNOPSIS
  Run Claude Bridge 24/7 on Windows via Task Scheduler (no extra deps).

.DESCRIPTION
  Registers a scheduled task "ClaudeBridge" that:
    - starts `bun run start` in the bridge root when you log on, and
    - auto-restarts it every minute if it ever exits/crashes,
  so the bridge — and its autonomous scheduler ("Quy trình") — stays up.

  This is the built-in, no-install option. For a true Windows Service
  (runs without an interactive login, separate log stream) install NSSM
  and point it at the same `bun run start`; see docs/24-7-setup.md.

  Output is appended to .bridge-state\bridge-service.log in the bridge root.

.PARAMETER Uninstall
  Remove the scheduled task instead of creating it.

.PARAMETER TaskName
  Override the scheduled-task name (default: ClaudeBridge).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$TaskName = "ClaudeBridge"
)

$ErrorActionPreference = "Stop"

# Bridge root = the parent of this script's directory.
$BridgeRoot = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  # Clean up the generated launcher too, so uninstall leaves nothing behind.
  $launcher = Join-Path (Join-Path $BridgeRoot ".bridge-state") "run-service.cmd"
  if (Test-Path $launcher) { Remove-Item -Path $launcher -Force -ErrorAction SilentlyContinue }
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "Task '$TaskName' is not registered — nothing to remove."
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  exit 0
}

# Resolve bun.exe — the task runs in a non-interactive context where PATH
# may differ, so bake in the absolute path.
$bun = (Get-Command bun -ErrorAction SilentlyContinue)
if ($null -eq $bun) {
  Write-Error "bun was not found on PATH. Install bun (https://bun.sh) or add it to PATH, then re-run."
  exit 1
}
$bunPath = $bun.Source

# Ensure the log dir exists.
$stateDir = Join-Path $BridgeRoot ".bridge-state"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$logFile = Join-Path $stateDir "bridge-service.log"

# Write a tiny launcher .cmd instead of cramming the whole command into the
# task's Argument string. Nested double-quoting of a `cmd /c` one-liner is
# fragile and breaks the `>>` redirection when the bun path / log path /
# bridge root contains spaces (e.g. C:\Users\John Smith\...). A .cmd file
# quotes each path at a single level, which cmd handles correctly.
$launcher = Join-Path $stateDir "run-service.cmd"
$launcherBody = @"
@echo off
cd /d "$BridgeRoot"
"$bunPath" run start >> "$logFile" 2>&1
"@
# OEM matches cmd.exe's console code page, so non-ASCII path characters
# (e.g. an accented Windows username) survive instead of becoming `?`.
Set-Content -Path $launcher -Value $launcherBody -Encoding OEM

# Run the launcher via cmd /c, with the launcher path quoted once.
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcher`"" -WorkingDirectory $BridgeRoot

# Fire at log on for the current user.
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Auto-restart on failure, run forever, never spawn a second copy.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

# Re-register cleanly if it already exists.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Claude Bridge — keeps the bridge + autonomous scheduler running 24/7." | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "  Bridge root : $BridgeRoot"
Write-Host "  Command     : $bunPath run start"
Write-Host "  Log file    : $logFile"
Write-Host ""
Write-Host "Start it now without logging off/on:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check status:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Remove:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall"
