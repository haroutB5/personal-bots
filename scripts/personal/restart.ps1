<#
.SYNOPSIS
Restarts Personal Bots on the active release (or switches to -Release first).

.DESCRIPTION
Stops the recorded server, then starts it again. When the "Personal Bots" logon
task is installed for the same root, the restart goes through the task so the
crash supervisor keeps running; otherwise start.ps1 runs directly.

-Release <name> makes that release active (releases\current.txt) before the
restart. Use it to roll back: restart.ps1 -Release <previous sha>

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restart.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root,
    [string]$Release,
    [string]$Node
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
$state = Read-PbServerState -Paths $paths
if (-not $Root) {
    if ($state -and $state.root) { $Root = [string]$state.root } else { $Root = 'dev' }
}

if ($Release) {
    $target = Get-PbRelease -Paths $paths -Release $Release
    Set-Content -LiteralPath $paths.CurrentFile -Value $target.Name -Encoding ASCII
    Write-Host "Active release set to $($target.Name)."
}

& (Join-Path $PSScriptRoot 'stop.ps1')

$task = Get-ScheduledTask -TaskName $PbTaskName -ErrorAction SilentlyContinue
$taskRoot = $null
if ($task) {
    foreach ($action in $task.Actions) {
        if ($action.Arguments -match '-Root\s+(dev|prod)') { $taskRoot = $Matches[1] }
    }
}

if ($task -and $taskRoot -eq $Root -and -not $Node) {
    # The old supervisor exits once it sees the stop marker; with
    # MultipleInstances=IgnoreNew a start before that would be dropped.
    for ($i = 0; $i -lt 60 -and (Get-ScheduledTask -TaskName $PbTaskName).State -eq 'Running'; $i++) {
        Start-Sleep -Milliseconds 500
    }
    Start-ScheduledTask -TaskName $PbTaskName
    for ($i = 0; $i -lt 120; $i++) {
        $next = Read-PbServerState -Paths $paths
        if ($next -and (Test-PbServerProcess -ProcessId ([int]$next.pid) -BinPath $next.binPath -BaseDir $next.baseDir)) {
            Write-Host "Personal Bots restarted through the '$PbTaskName' task (pid $($next.pid), release $($next.release))."
            exit 0
        }
        Start-Sleep -Milliseconds 500
    }
    throw "The '$PbTaskName' task did not bring the server back within 60s. Check the logs and status.ps1."
}

$startArgs = @{ Root = $Root }
if ($Node) { $startArgs.Node = $Node }
& (Join-Path $PSScriptRoot 'start.ps1') @startArgs
