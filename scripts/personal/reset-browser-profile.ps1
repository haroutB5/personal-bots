<#
.SYNOPSIS
Requests a one-time reset of the bots' shared browser profile. Run only after
Harout has said yes: it signs the bots' browser out of every site.

.DESCRIPTION
Writes <baseDir>\personal\browser-profile-reset.request and nothing else. The
server applies it at its next start, before any bot can use the browser:

1. If Chrome still holds the profile, it does nothing and reports why.
2. Moves the profile folder aside to
   personal\browser-profiles\default.before-reset-<UTC stamp> (the backup).
3. Clears the browser protections (login used, login origins, script-tainted
   origins), so page scripts follow the per-site rule from 1.60.16 on.
4. Deletes the request and writes personal\browser-profile-reset.result.json.

Saved logins live encrypted in the database and are not touched. This script
does not stop, start or restart anything: run backup.ps1 and restart.ps1 as
usual afterwards, then read the result file.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\reset-browser-profile.ps1 -Root dev -OwnerApproved

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\reset-browser-profile.ps1 -Root dev -Cancel
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('dev', 'prod')][string]$Root,
    [switch]$OwnerApproved,
    [switch]$Cancel
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root $Root
$state = Read-PbServerState -Paths $paths
$baseDir = if ($state -and $state.baseDir) { [string]$state.baseDir } else { $paths.BaseDir }
$personalDir = Join-Path $baseDir 'personal'
$request = Join-Path $personalDir 'browser-profile-reset.request'
$result = Join-Path $personalDir 'browser-profile-reset.result.json'

if ($Cancel) {
    if (Test-Path -LiteralPath $request) {
        Remove-Item -LiteralPath $request -Force
        Write-Host "Reset request removed: $request"
    } else {
        Write-Host 'No reset request was pending.'
    }
    exit 0
}

if (-not $OwnerApproved) {
    Write-Host 'Not requested. This signs the bots'' shared browser out of every site and discards its site data'
    Write-Host '(the old profile is kept as a backup folder). Re-run with -OwnerApproved once Harout has said yes.'
    exit 2
}

if (-not (Test-Path -LiteralPath $personalDir)) {
    Write-Error "No personal data folder at $personalDir"
    exit 1
}

$body = [ordered]@{ requestedAt = (Get-Date).ToUniversalTime().ToString('o'); requestedBy = $env:USERNAME }
[System.IO.File]::WriteAllText($request, ($body | ConvertTo-Json -Compress) + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Reset requested: $request"
Write-Host 'It is applied at the next server start. Back up and restart as usual (backup.ps1, restart.ps1),'
Write-Host "then check $result (status done, backupDir)."
exit 0
