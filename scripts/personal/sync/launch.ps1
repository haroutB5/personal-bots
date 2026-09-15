<#
.SYNOPSIS
Stable launcher for the weekly upstream sync. install-sync-task.ps1 copies it
to %USERPROFILE%\.personal-bots\upstream-sync\launch.ps1 and the scheduled task
runs that copy daily at 09:00.

.DESCRIPTION
Runs the full sync on Saturdays. On other days it runs only when the last run
was skipped at preflight (work in progress in the main checkout) and fewer
than 3 retries have happened, so a WIP Saturday is retried up to 3 days.
Before running, the sync worktree is fetched and detached at
origin/personal-bots/main, so the job always runs the script version on main,
never a half-merged copy. A dirty sync worktree means an earlier run needs a
human: the launcher raises an alert and stops.
#>
[CmdletBinding()]
param(
    [ValidateSet('Auto', 'DryRun')][string]$Mode = 'Auto',
    [string]$SyncRepo = 'C:\Claude\AI\personal-bots-sync',
    [switch]$Now
)

$ErrorActionPreference = 'Stop'
$syncHome = Join-Path $env:USERPROFILE '.personal-bots\upstream-sync'
$stateFile = Join-Path $syncHome 'state.json'
$alerts = 'C:\Claude\AI\urgot\data\alerts\personal-bots-sync.md'
New-Item -ItemType Directory -Force -Path $syncHome | Out-Null
$launchLog = Join-Path $syncHome 'launch.log'
function Log([string]$Text) {
    Add-Content -LiteralPath $launchLog -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -Encoding UTF8
}

$state = $null
if (Test-Path -LiteralPath $stateFile) {
    try { $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { $state = $null }
}
$isSaturday = (Get-Date).DayOfWeek -eq [System.DayOfWeek]::Saturday
$retryPending = $state -and $state.lastResult -eq 'skipped-preflight' -and [int]$state.consecutivePreflightSkips -lt 3
$ranToday = $state -and $state.lastRunAt -and ([datetime]$state.lastRunAt).ToLocalTime().Date -eq (Get-Date).Date
if (-not $Now) {
    if (-not ($isSaturday -or $retryPending)) { exit 0 }
    if ($ranToday -and -not $retryPending) { exit 0 }
}

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$dirty = @(& git -C $SyncRepo status --porcelain 2>$null)
$ErrorActionPreference = $previous
if ($dirty.Count -gt 0) {
    $message = "Bots upstream sync did not start: the sync worktree $SyncRepo is dirty (an earlier run needs attention)."
    Log $message
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $alerts) | Out-Null
    Add-Content -LiteralPath $alerts -Value ("- {0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $message) -Encoding UTF8
    exit 1
}

$ErrorActionPreference = 'Continue'
& git -C $SyncRepo fetch origin 2>&1 | Out-Null
& git -C $SyncRepo switch --detach origin/personal-bots/main 2>&1 | Out-Null
$switchCode = $LASTEXITCODE
$ErrorActionPreference = $previous
if ($switchCode -ne 0) {
    Log "git switch --detach origin/personal-bots/main failed ($switchCode) in $SyncRepo."
    exit 1
}

$script = Join-Path $SyncRepo 'scripts\personal\upstream-sync.ps1'
Log "Starting $script -Mode $Mode"
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Mode $Mode
$code = $LASTEXITCODE
Log "upstream-sync.ps1 exited $code"
exit $code
