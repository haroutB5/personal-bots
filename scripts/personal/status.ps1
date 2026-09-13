<#
.SYNOPSIS
Shows Personal Bots process, release, data root, local port, T3 Connect URL,
clock offset and the last log lines.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\status.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    [int]$Lines = 20,
    [string]$Node,
    [switch]$NoConnect,
    [switch]$NoClock
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root $Root
$state = Read-PbServerState -Paths $paths
$baseDir = $paths.BaseDir
$binPath = $null
$running = $false
if ($state) {
    $baseDir = [string]$state.baseDir
    $binPath = [string]$state.binPath
    $running = Test-PbServerProcess -ProcessId ([int]$state.pid) -BinPath $binPath -BaseDir $baseDir
}

Write-Host 'Personal Bots'
if ($running) {
    Write-Host "  Process:    running (pid $($state.pid), started $($state.startedAt), supervised $($state.supervised))"
} elseif ($state -and (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)) {
    Write-Host "  Process:    STALE record: pid $($state.pid) is alive but is not this server"
} elseif ($state) {
    Write-Host "  Process:    not running (recorded pid $($state.pid) exited)"
} else {
    Write-Host '  Process:    not running'
}
Write-Host "  Data root:  $baseDir"

$release = $null
if ($state -and $state.release) {
    $release = [pscustomobject]@{ Name = [string]$state.release; VersionFile = Join-Path $paths.ReleasesDir ([string]$state.release + '\VERSION') }
} elseif (Test-Path -LiteralPath $paths.CurrentFile) {
    try { $release = Get-PbRelease -Paths $paths; $binPath = $release.Bin } catch { $release = $null }
}
if ($release) {
    Write-Host "  Release:    $($release.Name)"
    if (Test-Path -LiteralPath $release.VersionFile) {
        Get-Content -LiteralPath $release.VersionFile | Where-Object { $_ -match '^(sha|branch|builtAt|cli)=' } |
            ForEach-Object { Write-Host "              $_" }
    }
} else {
    Write-Host '  Release:    none built'
}
if (Test-Path -LiteralPath $paths.CurrentFile) {
    $active = (Get-Content -LiteralPath $paths.CurrentFile -Raw).Trim()
    if ($release -and $active -ne $release.Name) {
        Write-Host "  Pending:    release $active is active; run restart.ps1 to apply it"
    }
}

$runtime = Read-PbRuntimeState -BaseDir $baseDir
if ($runtime) {
    $runtimeAlive = [bool](Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue)
    Write-Host ("  Local:      {0} (port {1}, server pid {2}, {3})" -f $runtime.origin, $runtime.port, $runtime.pid, $(if ($runtimeAlive) { 'alive' } else { 'exited' }))
} else {
    Write-Host '  Local:      no server-runtime.json yet'
}

$task = Get-ScheduledTask -TaskName $PbTaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $PbTaskName
    Write-Host ("  Logon task: installed, {0}, last result {1}" -f $task.State, $info.LastTaskResult)
} else {
    Write-Host '  Logon task: not installed'
}

if (-not $NoConnect -and $binPath -and (Test-Path -LiteralPath $binPath)) {
    # Uses the binary that is (or was last) serving this root, so a newer
    # build never touches the live database before restart.
    $nodeExe = Resolve-NodeExe -Node $Node
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = (& $nodeExe $binPath connect status --json --base-dir $baseDir 2>$null) -join "`n"
    $ErrorActionPreference = $previous
    $jsonStart = $raw.IndexOf('{')
    $connect = $null
    if ($jsonStart -ge 0) {
        try { $connect = $raw.Substring($jsonStart) | ConvertFrom-Json } catch { $connect = $null }
    }
    if ($connect) {
        $endpoint = 'not provisioned'
        if ($connect.PSObject.Properties.Name -contains 'endpointUrl' -and $connect.endpointUrl) { $endpoint = $connect.endpointUrl }
        Write-Host ("  T3 Connect: {0}, linked {1}, desired {2}" -f $endpoint, $connect.linked, $connect.desired)
    } else {
        Write-Host '  T3 Connect: status unavailable'
    }
}

if (-not $NoClock) {
    # DPoP proofs are rejected beyond ~5s of clock skew.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $chart = & "$env:SystemRoot\System32\w32tm.exe" /stripchart /computer:time.windows.com /samples:1 /dataonly 2>$null
    $ErrorActionPreference = $previous
    $offsetLine = @($chart | Where-Object { $_ -match '[+-]\d+\.\d+s' }) | Select-Object -Last 1
    if ($offsetLine -and $offsetLine -match '([+-]\d+\.\d+)s') {
        $offset = [double]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
        $verdict = 'ok'
        if ([math]::Abs($offset) -ge 2) { $verdict = 'FIX: Settings > Time & language > Date & time > Sync now' }
        Write-Host ("  Clock:      offset {0}s vs time.windows.com ({1})" -f $offset, $verdict)
    } else {
        Write-Host '  Clock:      could not reach time.windows.com'
    }
}

$latestLog = Get-ChildItem -LiteralPath $paths.LogsDir -Filter 'server-*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($latestLog) {
    Write-Host ''
    Write-Host "Last $Lines lines of $($latestLog.FullName):"
    Get-Content -LiteralPath $latestLog.FullName -Tail $Lines | ForEach-Object { Write-Host "  $_" }
}
