<#
.SYNOPSIS
Registers the "Personal Bots Upstream Sync" Task Scheduler task: current user,
no elevated privileges, daily at 09:00. The launcher runs the full weekly sync
on Saturdays and only preflight retries on other days.

.DESCRIPTION
Copies scripts\personal\sync\launch.ps1 to
%USERPROFILE%\.personal-bots\upstream-sync\launch.ps1 (a stable path outside
any checkout) and registers a task that runs it with -Mode Auto (the owner's
choice: fully automatic from the first run). -Mode DryRun registers a task
that stops before deploy instead.

Only ever creates or updates the task named "Personal Bots Upstream Sync", and
refuses to replace a task of that name that does not run the launcher.
Prerequisites (see scripts\personal\README.md, "Weekly upstream sync"): the
sync worktree at -SyncRepo with node_modules installed, and the "Sync reports"
bot + routine token in %USERPROFILE%\.personal-bots\upstream-sync\hook-token.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\install-sync-task.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('Auto', 'DryRun')][string]$Mode = 'Auto',
    [string]$SyncRepo = 'C:\Claude\AI\personal-bots-sync',
    [string]$At = '09:00'
)

. (Join-Path $PSScriptRoot 'common.ps1')

$taskName = 'Personal Bots Upstream Sync'
$user = "$env:USERDOMAIN\$env:USERNAME"
$syncHome = Join-Path $PbHome 'upstream-sync'
$launcher = Join-Path $syncHome 'launch.ps1'

if (-not (Test-Path -LiteralPath (Join-Path $SyncRepo 'scripts\personal\upstream-sync.ps1') -PathType Leaf)) {
    throw "No sync worktree at $SyncRepo (scripts\personal\upstream-sync.ps1 missing)."
}
if (-not (Test-Path -LiteralPath (Join-Path $SyncRepo 'node_modules') -PathType Container)) {
    throw "$SyncRepo has no node_modules. Run vp i there first."
}
if (-not (Test-Path -LiteralPath (Join-Path $syncHome 'hook-token') -PathType Leaf)) {
    Write-Warning "No $syncHome\hook-token yet: runs will fall back to the alert file and a toast until the Sync reports routine is set up."
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $ours = @($existing.Actions | Where-Object { $_.Arguments -and $_.Arguments -match 'upstream-sync\\launch\.ps1' })
    if ($ours.Count -eq 0) {
        throw "A task named '$taskName' exists but does not run the upstream-sync launcher. Refusing to replace it."
    }
}

New-Item -ItemType Directory -Force -Path $syncHome | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'sync\launch.ps1') -Destination $launcher -Force

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1} -SyncRepo "{2}"' -f $launcher, $Mode, $SyncRepo
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $syncHome
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew
$description = "Weekly upstream T3 Code sync for Personal Bots (Saturday $At, -Mode $Mode; weekday runs only retry a preflight skip). Managed by scripts\personal\install-sync-task.ps1."
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $taskName
Write-Host "Registered task '$taskName' for $user, daily at $At (full sync on Saturdays), -Mode $Mode, state $($registered.State)."
Write-Host "  Action: $powershell $arguments"
Write-Host "  Run it now (ignores the Saturday rule): powershell -File `"$launcher`" -Mode $Mode -Now"
