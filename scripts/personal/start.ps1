<#
.SYNOPSIS
Starts the Personal Bots server from the active release against a data root.

.DESCRIPTION
Runs: node <release>\dist\bin.mjs serve --base-dir %USERPROFILE%\.personal-bots\<Root> --no-browser
with T3CODE_ENVIRONMENT_LABEL=Bots and the repo .env public config.
Output goes to %USERPROFILE%\.personal-bots\logs\server-YYYYMMDD.log (7 kept).
The PID is recorded in %USERPROFILE%\.personal-bots\run\server.pid (+ server.json).

Refuses to start when any live T3 server already owns the data root, so it can
never run beside another server on the same database.

-Wait keeps this script in the foreground as a supervisor (used by the logon
task): it restarts the server after a crash (3 times, 1 minute apart) and exits
0 when stop.ps1 stopped it on purpose.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\start.ps1 -Root prod
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    [string]$Release,
    [string]$Node,
    [int]$Port = 0,
    [string]$Label = 'Bots',
    [switch]$Wait
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root $Root
foreach ($dir in @($paths.LogsDir, $paths.RunDir, $paths.BaseDir, $paths.WorkDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$existing = Read-PbServerState -Paths $paths
if ($existing -and (Test-PbServerProcess -ProcessId ([int]$existing.pid) -BinPath $existing.binPath -BaseDir $existing.baseDir)) {
    Write-Host "Personal Bots is already running (pid $($existing.pid), root $($existing.root))."
    exit 0
}

$release = Get-PbRelease -Paths $paths -Release $Release
$nodeExe = Resolve-NodeExe -Node $Node
$null = Import-RepoDotEnv
Clear-DevOriginEnv
$env:T3CODE_ENVIRONMENT_LABEL = $Label

function Assert-DataRootFree {
    $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
    if ($null -eq $runtime -or -not $runtime.pid) { return }
    $owner = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
    if ($owner -and $owner.ProcessName -eq 'node') {
        throw ("A T3 server (pid {0}, {1}) already serves {2}. Stop it first: two servers must never share a data root." -f `
                $runtime.pid, $runtime.origin, $paths.BaseDir)
    }
}

function Write-PbLog([string]$Message) {
    Add-Content -LiteralPath $script:logFile -Value ('=== {0} {1}' -f (Get-Date).ToString('s'), $Message) -Encoding UTF8
}

function Start-PbServerOnce {
    Assert-DataRootFree
    $script:logFile = Join-Path $paths.LogsDir ('server-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
    Write-PbLog ("start release {0} root {1} base {2}" -f $release.Name, $Root, $paths.BaseDir)
    Remove-PbOldFiles -Directory $paths.LogsDir -Filter 'server-*.log' -Keep 7
    if (Test-Path -LiteralPath $paths.StopMarker) { Remove-Item -LiteralPath $paths.StopMarker -Force }

    $launchedAt = Get-Date
    $proc = Start-PbServeProcess -NodeExe $nodeExe -BinPath $release.Bin -BaseDir $paths.BaseDir `
        -LogFile $script:logFile -WorkingDirectory $paths.WorkDir -Port $Port
    $state = [ordered]@{
        pid        = $proc.Id
        root       = $Root
        baseDir    = $paths.BaseDir
        binPath    = $release.Bin
        release    = $release.Name
        logFile    = $script:logFile
        startedAt  = $launchedAt.ToUniversalTime().ToString('o')
        supervised = [bool]$Wait
    }
    Set-Content -LiteralPath $paths.PidFile -Value $proc.Id -Encoding ASCII
    Set-Content -LiteralPath $paths.StateFile -Value ($state | ConvertTo-Json) -Encoding ASCII

    # Ready = the server rewrote server-runtime.json after this launch.
    for ($i = 0; $i -lt 120; $i++) {
        if ($proc.HasExited) {
            Write-Warning "Server exited during startup (code $($proc.ExitCode)). Last log lines:"
            Get-Content -LiteralPath $script:logFile -Tail 20 | ForEach-Object { Write-Host "  $_" }
            Clear-PbServerState -Paths $paths
            throw 'Personal Bots failed to start.'
        }
        $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
        if ($runtime -and $runtime.startedAt -and ([datetime]$runtime.startedAt) -ge $launchedAt.AddSeconds(-2)) {
            Write-Host ("Personal Bots started: pid {0}, {1}, root {2}, release {3}" -f $proc.Id, $runtime.origin, $Root, $release.Name)
            return $proc
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Warning "Server is running (pid $($proc.Id)) but has not reported ready after 60s. Check $($script:logFile)."
    return $proc
}

$proc = Start-PbServerOnce
if (-not $Wait) { exit 0 }

$restarts = 0
while ($true) {
    $startedAt = Get-Date
    $proc.WaitForExit()
    $code = $proc.ExitCode
    if (Test-Path -LiteralPath $paths.StopMarker) {
        Remove-Item -LiteralPath $paths.StopMarker -Force
        Write-PbLog 'stopped by stop.ps1'
        exit 0
    }
    Write-PbLog "server exited unexpectedly with code $code"
    Clear-PbServerState -Paths $paths
    if (((Get-Date) - $startedAt).TotalMinutes -ge 10) { $restarts = 0 }
    if ($restarts -ge 3) {
        Write-PbLog 'giving up after 3 restarts'
        exit 1
    }
    $restarts++
    Start-Sleep -Seconds 60
    if (Test-Path -LiteralPath $paths.StopMarker) {
        Remove-Item -LiteralPath $paths.StopMarker -Force
        exit 0
    }
    Write-PbLog "restart $restarts of 3"
    $proc = Start-PbServerOnce
}
