<#
.SYNOPSIS
Stops the Personal Bots server recorded in %USERPROFILE%\.personal-bots\run\server.json.

.DESCRIPTION
Kills only the recorded PID and its child tree, and only after confirming that
PID's command line still names the recorded release binary and data root.
Never kills by process name. Leaves any other T3 server alone.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\stop.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
$state = Read-PbServerState -Paths $paths
if ($null -eq $state) {
    Write-Host 'Personal Bots is not running (no run\server.json).'
    exit 0
}

$processId = [int]$state.pid
if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    Write-Host "Personal Bots is not running (recorded pid $processId has exited)."
    Clear-PbServerState -Paths $paths
    exit 0
}

if (-not (Test-PbServerProcess -ProcessId $processId -BinPath $state.binPath -BaseDir $state.baseDir)) {
    $message = 'PID {0} is alive but its command line does not name {1} and {2}. Refusing to kill it. ' +
        'If Personal Bots is already gone, delete {3}.'
    throw ($message -f $processId, $state.binPath, $state.baseDir, $paths.StateFile)
}

# Tells a -Wait supervisor this exit is intentional, so it does not restart.
Set-Content -LiteralPath $paths.StopMarker -Value (Get-Date).ToString('o') -Encoding ASCII
if (-not (Stop-PbProcessTree -ProcessId $processId)) {
    throw "PID $processId is still alive after taskkill."
}
Clear-PbServerState -Paths $paths
Write-Host "Stopped Personal Bots (pid $processId, root $($state.root))."
