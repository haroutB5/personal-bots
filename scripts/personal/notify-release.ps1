<#
.SYNOPSIS
Tells the chat that asked for a release how it went: one turn in that chat,
the moment the release waiter knows.

.DESCRIPTION
Writes one JSON notice into <baseDir>\personal\release-notices\. The running
server (1.60.18 and later) picks it up within about 5 seconds and posts it as
one turn in the bot chat named by -ThreadId, with the version, smoke result,
rollback status and log path. The bot (the CTO) wakes up on it and confirms
the release and starts QA, so nobody schedules a check on a guessed timer.

Call it once, at the waiter's end state:
  -Outcome live             activated and the smoke (and any extended checks) passed
  -Outcome rolled_back      the smoke failed; the previous release is back and passed its smoke
  -Outcome rollback_failed  the smoke failed and the rollback or its smoke failed too
  -Outcome failed           stopped before the restart (backup failed, work resumed, ...)

Without -ThreadId it posts nothing and exits 0, so a waiter can always call it.
Only a bot chat gets the post; any other thread id is refused by the server
(the notice moves to release-notices\rejected\ and the server log says why).
A notice written while a server older than 1.60.18 runs (for example after a
rollback to one) waits in the folder and is posted by the next server that
reads it.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\notify-release.ps1 -ThreadId <cto chat id> -Version 1.60.18 -Release <sha12> -Outcome live -SmokeExit 0 -LogPath <waiter log>

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\notify-release.ps1 -ThreadId <cto chat id> -Version 1.60.18 -Release <sha12> -Outcome rolled_back -SmokeExit 1 -RollbackRelease <previous sha12> -RollbackExit 0 -RollbackSmokeExit 0 -LogPath <waiter log> -Detail 'FAIL ...'
#>
[CmdletBinding()]
param(
    [string]$ThreadId,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Release,
    [Parameter(Mandatory = $true)][ValidateSet('live', 'rolled_back', 'rollback_failed', 'failed')][string]$Outcome,
    [Nullable[int]]$SmokeExit,
    [string]$RollbackRelease,
    [Nullable[int]]$RollbackExit,
    [Nullable[int]]$RollbackSmokeExit,
    [string]$LogPath,
    [string]$Detail,
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    # A throwaway server's data root; defaults to the running server's.
    [string]$BaseDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $ThreadId -or -not $ThreadId.Trim()) {
    Write-Host 'No -ThreadId: no release notice posted.'
    exit 0
}

if (-not $BaseDir) {
    $paths = Get-PbPaths -Root $Root
    $state = Read-PbServerState -Paths $paths
    $BaseDir = if ($state -and $state.baseDir) { [string]$state.baseDir } else { $paths.BaseDir }
}
$inbox = Join-Path (Join-Path $BaseDir 'personal') 'release-notices'

function Get-TextOrNull([string]$Value) {
    if ($Value -and $Value.Trim()) { return $Value.Trim() } else { return $null }
}

$notice = [ordered]@{
    threadId          = $ThreadId.Trim()
    version           = $Version.Trim()
    release           = $Release.Trim()
    outcome           = $Outcome
    smokeExit         = $SmokeExit
    rollbackRelease   = Get-TextOrNull $RollbackRelease
    rollbackExit      = $RollbackExit
    rollbackSmokeExit = $RollbackSmokeExit
    logPath           = Get-TextOrNull $LogPath
    detail            = Get-TextOrNull $Detail
    writtenAt         = (Get-Date).ToUniversalTime().ToString('o')
}

try {
    New-Item -ItemType Directory -Force -Path $inbox | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
    $safeVersion = ($Version.Trim() -replace '[^A-Za-z0-9_.-]', '-')
    $name = "$stamp-$safeVersion-$Outcome.json"
    $temp = Join-Path $inbox "$name.tmp"
    # Written aside and renamed in, so the server never reads half a file.
    [System.IO.File]::WriteAllText($temp, ($notice | ConvertTo-Json -Compress) + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination (Join-Path $inbox $name)
    Write-Host "Release notice queued for thread $($notice.threadId): $(Join-Path $inbox $name)"
    exit 0
} catch {
    Write-Warning "Release notice not written: $($_.Exception.Message)"
    exit 1
}
