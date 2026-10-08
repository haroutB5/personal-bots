<#
.SYNOPSIS
Phone e2e smoke suite for a staged hbots release: five journeys in a real browser against a throwaway server.

.DESCRIPTION
Starts a fresh throwaway server from the release (scripts\personal\throwaway-server.ps1: fresh root under %TEMP%, fake
Claude CLIs, Sonnet 5.5 seed, free port), pairs a 390x844 dark touch Chrome with it and runs the journeys in
scripts\personal\e2e\journeys.mjs:

  bots-list-chat    Bots list -> open a bot's chat -> send a message -> the fake reply -> the chat is a list row
  new-chat-named    New chat from the list and from a bot's New chat button, with a name each time
  delegate-task     a bot delegates a task (fake CLI MCPTOOL delegate_task) and the result comes back
  chats-search      Chats search finds a sent message and opens its chat
  long-press-reply  long-press a message -> Reply -> the sent message carries its quote

Each journey must finish inside 30 s and the whole suite inside -SuiteTimeoutSeconds (default 180; 420 when -Journey names offline-queue). It always stops its
server by PID and deletes its root (throwaway-server.ps1 -Stop), checks the root and the port are gone, and removes its
artifacts on a pass. On a failure it keeps a screenshot and the page text per failed journey in the artifacts folder.
It never touches a live data root or the real Claude account (the fake CLI answers everything), and the browser is
blocked from every origin except the throwaway server.

Exit code: 0 all journeys passed; 1 a journey failed; 2 setup failed (server, browser, pairing); 3 something was left
behind (root or port) or the suite hit its time limit. Playwright comes from the release's own node_modules
(playwright-core is one of its externals), so this works from a release-tools copy of scripts\personal too. Needs Google
Chrome (set E2E_BROWSER_CHANNEL=msedge for Edge).

.PARAMETER Release
A release folder (has dist\bin.mjs), a built worktree (apps\server\dist\bin.mjs) or a sha12 under ~\.personal-bots\releases.

.PARAMETER Journey
Comma-separated journey ids to run instead of all five (for a re-test of one failure). `offline-queue` is not one of
the five: it stops and restarts the throwaway server to prove the phone's offline send queue (e2e\offlineQueue.mjs).

.PARAMETER Json
Prints one JSON line with the result at the end (for a release waiter or a gate).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release C:\Users\Ht\.personal-bots\releases\<sha12>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release <sha12> -Journey chats-search -Json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [string]$Journey,
    [string]$Name,
    [string]$ArtifactsDir,
    [string]$Node,
    [int]$SuiteTimeoutSeconds = 0,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$twScript = Join-Path $PSScriptRoot 'throwaway-server.ps1'
# The five smoke journeys fit 180 s. A journey that stops and restarts the server (offline-queue) needs longer.
if ($SuiteTimeoutSeconds -le 0) { $SuiteTimeoutSeconds = if ($Journey -match 'offline-queue') { 420 } else { 180 } }
$runner = Join-Path $PSScriptRoot 'e2e\run.mjs'
$nodeExe = Resolve-NodeExe -Node $Node
if (-not $Name) { $Name = 'e2e-{0}-{1}' -f (Get-Date -Format 'MMddHHmmss'), $PID }
if (-not $ArtifactsDir) { $ArtifactsDir = Join-Path ([System.IO.Path]::GetTempPath().TrimEnd('\')) ('hbots-e2e\' + $Name) }

function Invoke-TwScript {
    param([string[]]$ScriptArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $twScript @ScriptArgs 2>&1 | ForEach-Object { "$_" }
        return @{ Code = $LASTEXITCODE; Output = @($output) }
    } finally {
        $ErrorActionPreference = $previous
    }
}

$exit = 2
$server = $null
$serverStarted = $false
$result = $null
$leftovers = @()
$startedAt = Get-Date
try {
    $start = Invoke-TwScript -ScriptArgs @('-Name', $Name, '-Release', $Release, '-Node', $nodeExe, '-Json')
    $serverStarted = $true  # even a half-started root is removed by -Stop below
    $jsonLine = $start.Output | Where-Object { $_ -match '^\s*\{.*\}\s*$' } | Select-Object -Last 1
    if ($start.Code -ne 0 -or -not $jsonLine) {
        throw ("throwaway-server.ps1 failed (exit {0}): {1}" -f $start.Code, (($start.Output | Select-Object -Last 5) -join ' | '))
    }
    $server = $jsonLine | ConvertFrom-Json
    Write-Host ("e2e server {0} at {1} (release {2})" -f $Name, $server.URL, $Release)

    $record = Get-Content -LiteralPath (Join-Path $server.Root 'throwaway.json') -Raw | ConvertFrom-Json
    New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
    $stdout = Join-Path $ArtifactsDir 'runner.out.txt'
    $stderr = Join-Path $ArtifactsDir 'runner.err.txt'
    $runnerArgs = @($runner, '--url', $server.URL, '--pair', $server.Pairing, '--bin', [string]$record.bin, '--out', $ArtifactsDir,
        '--name', $Name, '--tw', $twScript, '--root', [string]$server.Root)
    if ($Journey) { $runnerArgs += @('--journeys', $Journey) }
    if ($env:E2E_BROWSER_CHANNEL) { $runnerArgs += @('--channel', $env:E2E_BROWSER_CHANNEL) }
    $quoted = ($runnerArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $quoted -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $procId = $proc.Id
    $null = $proc.Handle  # keeps the handle open so ExitCode is readable after the process ends (Windows PowerShell 5.1)
    if (-not $proc.WaitForExit($SuiteTimeoutSeconds * 1000)) {
        Write-Warning "e2e suite is past $SuiteTimeoutSeconds s; stopping the runner (PID $procId) and its browser."
        $browserPidFile = Join-Path $ArtifactsDir 'browser.pid'
        if (Test-Path -LiteralPath $browserPidFile) {
            $browserPid = [int](Get-Content -LiteralPath $browserPidFile -Raw)
            & taskkill.exe /PID $browserPid /T /F 2>&1 | Out-Null
        }
        & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
        $leftovers += "suite exceeded $SuiteTimeoutSeconds s"
        $exit = 3
    } else {
        $proc.WaitForExit()
        $exit = $proc.ExitCode
        if ($null -eq $exit) { $exit = 2 }
    }
    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout | ForEach-Object { Write-Host $_ } }
    if ((Test-Path -LiteralPath $stderr) -and (Get-Item -LiteralPath $stderr).Length -gt 0) {
        Get-Content -LiteralPath $stderr | ForEach-Object { Write-Host $_ }
    }
    $resultFile = Join-Path $ArtifactsDir 'result.json'
    if (Test-Path -LiteralPath $resultFile) { $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json }
    # The runner's own verdict is the source of truth for pass and fail; a missing file means it never finished.
    if ($exit -ne 3) {
        if ($null -eq $result) { $exit = 2 }
        elseif ($result.ok) { $exit = 0 }
        elseif ($result.setupError) { $exit = 2 }
        else { $exit = 1 }
    }
} catch {
    Write-Host ("e2e setup failed: {0}" -f $_.Exception.Message)
    $exit = 2
} finally {
    if ($serverStarted) {
        $stop = Invoke-TwScript -ScriptArgs @('-Stop', $Name)
        $stop.Output | Select-Object -Last 2 | ForEach-Object { Write-Host $_ }
    }
    $root = Join-Path ([System.IO.Path]::GetTempPath().TrimEnd('\')) ('hbots-tw-' + $Name)
    if (Test-Path -LiteralPath $root) { $leftovers += "root $root still exists" }
    if ($server) {
        $listening = @(Get-NetTCPConnection -LocalPort ([int]([uri]$server.URL).Port) -State Listen -ErrorAction SilentlyContinue)
        if ($listening.Count -gt 0) { $leftovers += "port $(([uri]$server.URL).Port) still listening (PID $($listening[0].OwningProcess))" }
    }
}

if ($leftovers.Count -gt 0) {
    Write-Host ("e2e LEFTOVERS: {0}" -f ($leftovers -join '; '))
    if ($exit -eq 0 -or $exit -eq 1) { $exit = 3 }
}
if ($exit -eq 0 -and (Test-Path -LiteralPath $ArtifactsDir)) {
    Remove-Item -LiteralPath $ArtifactsDir -Recurse -Force -ErrorAction SilentlyContinue
    $artifactsParent = Split-Path -Parent $ArtifactsDir
    if ((Split-Path -Leaf $artifactsParent) -eq 'hbots-e2e' -and @(Get-ChildItem -LiteralPath $artifactsParent -Force).Count -eq 0) {
        Remove-Item -LiteralPath $artifactsParent -Force -ErrorAction SilentlyContinue
    }
} elseif (Test-Path -LiteralPath $ArtifactsDir) {
    Write-Host "e2e artifacts kept for the failure: $ArtifactsDir"
}
$seconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
Write-Host ("e2e smoke exit {0} in {1} s" -f $exit, $seconds)
if ($Json) {
    $failureLines = @()
    if ($result) {
        $failureLines = @($result.results | Where-Object { -not $_.ok } | ForEach-Object { ("$($_.id): $($_.error)" -split "`n")[0] })
        if ($result.setupError) { $failureLines += (("setup: $($result.setupError)" -split "`n")[0]) }
    }
    $summary = [ordered]@{
        exit = $exit
        seconds = $seconds
        release = $Release
        passed = if ($result) { $result.passed } else { 0 }
        failed = if ($result) { $result.failed } else { $null }
        failures = [string[]]$failureLines
        journeys = @(if ($result -and $result.results) { $result.results | ForEach-Object { [ordered]@{ id = [string]$_.id; ok = [bool]$_.ok; ms = $_.ms } } })
        leftovers = $leftovers
        artifacts = if ($exit -eq 0) { $null } else { $ArtifactsDir }
    }
    Write-Output ($summary | ConvertTo-Json -Compress)
}
exit $exit
