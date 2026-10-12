<#
.SYNOPSIS
The scripted 1.66.35 checks on throwaway servers: the stall load, the console-burst kill (F1),
the stall-capture location (F3), the steer/pending-row check and the usage-scan isolation check.

.DESCRIPTION
Extends qa-16633.ps1 (which still covers 1.66.33's checks). Starts throwaway roots
(throwaway-server.ps1, fake Claude CLIs, Sonnet seed) and runs:
  -Load      : a disk-load generator on the same volume while a scripted phone drives the two hot
               paths (the Usage card's "Refresh usage" = rpc:server.refreshProviders, and a
               streaming SLOW bot turn), then reads the server log's stall recorder lines. FAILS
               when any walk/spawn stall ran 1 s or longer (scripts\personal\e2e\stall-load.mjs +
               stall-report.mjs). Run it on the old release and the new one and compare.
  -Console   : a throwaway started with the console-burst probe (e2e\console-burst-probe.cjs):
               a burst of numbered lines is written to the redirected server log and the server is
               killed with taskkill /F mid-burst. FAILS when more than two write batches' worth of
               accepted lines are missing from the log (F1: with the batched writer the loss is the
               batch in flight; before, a mid-burst kill lost the whole backlog - 845 of 74,500).
               The same root then proves F3: a provoked 1.5 s main-thread stall must land its
               capture under the root's own userdata\logs\stalls, and no new capture naming this
               release may appear in the LIVE ~\.personal-bots\logs\stalls.
  -Steer     : the real steer order on the fake CLI (slow turn, tap-send a second message mid-turn,
               the turn ENDS), then the database check: no pending turn-start row may remain, and
               the release's idle-classification-16635.mjs must see the table (pending counts 0).
  -Isolation : opens the Team screen's Token usage card on the fresh root: the scan must find NO
               tokens anywhere, which fails if it read this PC's real Claude/OpenCode/DeepSeek homes.
  -Retention : drives e2e\retention-load-check.ps1 (F2): seeds >600 MB into the root's REAL
               provider-log directory (userdata\logs\provider), boots under disk load, and FAILS
               unless the pass really ran (stale files gone, total trimmed to the 512 MB cap,
               unrelated files kept, no >= 1 s stall).
Needs Chrome (playwright-core from the release's own node_modules; same rig as the e2e smoke).
Throwaways are stopped with -Stop at the end (also on failure) unless -Keep is given.
Heavy load: do not run between 23:00 and 07:00 or while a release waiter is armed.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16635.ps1 -Release C:\Claude\AI\_wt\hbots-16635
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16635.ps1 -Release 970a9683d1aa -SkipSteer -SkipIsolation
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [string]$Name = 'qa16635',
    # Refresh-loop seconds. Deliberately under the 30 s resolution-cache TTL:
    # the loop measures repeated resolutions (where the live stalls came from),
    # after one warm-up refresh the fixed server resolves into the cache.
    [int]$LoadSeconds = 28,
    # Lines written by the console burst before the kill. Large enough that the
    # writer is still draining when taskkill lands (each batch is ~1 MiB).
    [int]$BurstLines = 400000,
    [string]$Out = '',
    # Which throwaway-server.ps1 to start from (a baseline run against an older
    # release passes that release's own copy).
    [string]$ThrowawayScript = '',
    [switch]$SkipLoad,
    [switch]$SkipConsole,
    [switch]$SkipSteer,
    [switch]$SkipIsolation,
    [switch]$SkipRetention,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$script:failures = @()
function Step($what, $script) {
    Write-Output ("=== " + $what)
    try { & $script; if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "exit $LASTEXITCODE" } }
    catch {
        $script:failures += "${what}: $($_.Exception.Message)"
        Write-Warning "${what} FAILED: $($_.Exception.Message)"
    }
}

$script:pairCounter = 0
# Every browser session needs its own single-use pairing link (one is consumed
# per pairContext); the link from the initial start is used by nothing.
function New-PairLink {
    param([string]$ForName = $Name)
    $script:pairCounter += 1
    $text = (& $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Pair $ForName | Out-String)
    $url = [regex]::Match($text, 'https?://\S+').Value
    if (-not $url) { throw "no pairing link in: $text" }
    # Write-Host, not Write-Output: the return value must be the URL alone.
    Write-Host "    pairing link $($script:pairCounter) minted"
    return $url
}

if (-not $Out) { $Out = Join-Path $env:TEMP ('hbots-qa16635-' + (Get-Date -Format 'HHmmss')) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Output "out: $Out"

$nodeExe = Resolve-NodeExe
$throwaway = if ($ThrowawayScript) { $ThrowawayScript } else { Join-Path $PSScriptRoot 'throwaway-server.ps1' }
if (-not (Test-Path -LiteralPath $throwaway -PathType Leaf)) { throw "no throwaway-server.ps1 at $throwaway" }
$e2e = Join-Path $PSScriptRoot 'e2e'
$ps = Join-Path $PSHOME 'powershell.exe'
$liveStallsDir = Join-Path (Get-PbPaths -Root dev).LogsDir 'stalls'

# ---------------------------------------------------------------- start
Write-Output "=== starting throwaway '$Name' from $Release"
$info = & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Name $Name -Release $Release -Json | ConvertFrom-Json
$root = [string]$info.Root
$record = Get-Content -LiteralPath (Join-Path $root 'throwaway.json') -Raw | ConvertFrom-Json
$bin = [string]$record.bin
Write-Output "    $($info.URL) version=$($info.Version) pid=$($info.PID)"

# ---------------------------------------------------------------- disk load generator
# Two parallel jobs: write-through streaming (the backup's shape) and a
# create/delete metadata storm (the worktree cleanup's shape - this is what
# makes statSync and CreateProcess take hundreds of milliseconds on this
# laptop; a big sequential write alone barely slows NTFS metadata lookups).
function Start-DiskLoad([int]$Seconds) {
    $dir = Join-Path $env:TEMP 'hbots-load-16635'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $writer = Start-Job -ArgumentList $dir, $Seconds -ScriptBlock {
        param($dir, $seconds)
        $deadline = (Get-Date).AddSeconds($seconds)
        $rng = [System.Random]::new(7)
        $chunk = New-Object byte[] 16777216
        $rng.NextBytes($chunk)
        while ((Get-Date) -lt $deadline) {
            $file = Join-Path $dir ('load-{0}.bin' -f ($rng.Next()))
            $fs = [System.IO.File]::Create($file)
            try { for ($i = 0; $i -lt 48; $i++) { $fs.Write($chunk, 0, $chunk.Length); $fs.Flush($true) } }
            finally { $fs.Dispose() }
            Remove-Item -LiteralPath $file -Force
        }
    }
    $churn = Start-Job -ArgumentList $dir, $Seconds -ScriptBlock {
        param($dir, $seconds)
        $deadline = (Get-Date).AddSeconds($seconds)
        $rng = [System.Random]::new(3)
        while ((Get-Date) -lt $deadline) {
            $pass = Join-Path $dir ('meta-{0}' -f ($rng.Next()))
            for ($d = 0; $d -lt 20; $d++) {
                $sub = Join-Path $pass "d$d"
                New-Item -ItemType Directory -Force -Path $sub | Out-Null
                for ($i = 0; $i -lt 120; $i++) { [System.IO.File]::WriteAllText((Join-Path $sub "f$i.dat"), 'x') }
            }
            Remove-Item -LiteralPath $pass -Recurse -Force
        }
    }
    return @($writer, $churn)
}

function Stop-DiskLoad($jobs, [int]$Seconds) {
    foreach ($job in $jobs) {
        Wait-Job -Job $job -Timeout ([Math]::Max(60, $Seconds)) | Out-Null
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $env:TEMP 'hbots-load-16635') -Recurse -Force -ErrorAction SilentlyContinue
}

try {
    if (-not $SkipLoad) {
        Step 'stall load (disk load + refresh/stream driver)' {
            # The throwaway keeps its ABSOLUTE fake binary path: a bare command
            # name resolves through PATH, and this machine's real
            # C:\Users\Ht\.local\bin\claude.exe sits there (it ran a real turn
            # once during a 1.66.33 dry run - never again).
            $jobs = Start-DiskLoad ($LoadSeconds + 30)
            Start-Sleep -Seconds 4
            try {
                & $nodeExe (Join-Path $e2e 'stall-load.mjs') --origin $info.URL --pair (New-PairLink) --bin $bin --out $Out --seconds $LoadSeconds
                if ($LASTEXITCODE -ne 0) { throw "stall-load exit $LASTEXITCODE" }
            } finally {
                Stop-DiskLoad $jobs $LoadSeconds
            }
            & $nodeExe (Join-Path $e2e 'stall-report.mjs') (Join-Path $root 'server.log') | Tee-Object -FilePath (Join-Path $Out 'stall-report.txt')
            & $nodeExe (Join-Path $e2e 'stall-report.mjs') (Join-Path $root 'server.log') --json |
                Set-Content -LiteralPath (Join-Path $Out 'stall-report.json')
            $summary = Get-Content -LiteralPath (Join-Path $Out 'stall-report.json') -Raw | ConvertFrom-Json
            if ($summary.targetedOver1s -gt 0) {
                throw "$($summary.targetedOver1s) walk/spawn stall(s) of 1 s or more in the load run"
            }
        }
    }

    if (-not $SkipConsole) {
        Step 'console burst kill loses at most a write batch (F1)' {
            # A second throwaway, this one preloaded with the probe. NODE_OPTIONS
            # and QA_PROBE_DIR are inherited by the detached cmd launch.
            $prevNodeOptions = $env:NODE_OPTIONS
            $prevProbeDir = $env:QA_PROBE_DIR
            $consoleName = $Name + 'c'
            $probeDir = Join-Path $Out 'console-probe'
            New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
            $consoleInfo = $null
            try {
                $env:NODE_OPTIONS = '--require ' + (Join-Path $e2e 'console-burst-probe.cjs')
                $env:QA_PROBE_DIR = $probeDir
                $consoleInfo = & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Name $consoleName -Release $Release -Json | ConvertFrom-Json
            } finally {
                $env:NODE_OPTIONS = $prevNodeOptions
                $env:QA_PROBE_DIR = $prevProbeDir
            }
            $consoleRoot = [string]$consoleInfo.Root
            $serverPid = [int]$consoleInfo.Server
            Write-Output "    probe root $consoleRoot (server pid $serverPid)"
            try {
                Set-Content -LiteralPath (Join-Path $probeDir 'burst-a.json') -Value (@{ n = $BurstLines; chunk = 4000 } | ConvertTo-Json -Compress)
                # Wait until the server accepted at least half the burst, then kill it hard.
                $accepted = 0
                $deadline = (Get-Date).AddSeconds(60)
                while ((Get-Date) -lt $deadline) {
                    if (Test-Path -LiteralPath (Join-Path $probeDir 'burst-a.done')) { break }
                    if (Test-Path -LiteralPath (Join-Path $probeDir 'burst-a.accepted')) {
                        $accepted = [int](Get-Content -LiteralPath (Join-Path $probeDir 'burst-a.accepted') -Raw)
                        if ($accepted -ge ($BurstLines / 2)) { break }
                    }
                    Start-Sleep -Milliseconds 100
                }
                $completed = Test-Path -LiteralPath (Join-Path $probeDir 'burst-a.done')
                if (-not $completed -and $accepted -lt ($BurstLines / 2)) {
                    throw "the burst never reached half of $BurstLines accepted (accepted=$accepted)"
                }
                if (-not $completed) {
                    & taskkill /F /PID $serverPid 2>&1 | Out-Null
                    Start-Sleep -Seconds 2
                }
                $done = if ($completed) { Get-Content -LiteralPath (Join-Path $probeDir 'burst-a.done') -Raw | ConvertFrom-Json } else { $null }
                if ($done -and (-not $done.patchedOut -or -not $done.patchedErr)) {
                    throw "the async console writer was not installed (patchedOut=$($done.patchedOut) patchedErr=$($done.patchedErr))"
                }
                $acceptedText = Get-Content -LiteralPath (Join-Path $probeDir 'burst-a.accepted') -Raw
                $accepted = [int]$acceptedText
                $landed = @(Select-String -Path (Join-Path $consoleRoot 'server.log') -Pattern 'QAPROBE burst-a ' -SimpleMatch).Count
                # One batch is 1 MiB; a probe line is about 95 bytes, so ~11,000
                # lines. Two batches is the bound the check allows (the kill can
                # land while one batch is in flight and one more queues behind).
                $batchLines = [Math]::Ceiling(1048576 / 95)
                $lost = [Math]::Max(0, $accepted - $landed)
                $lostOverall = [Math]::Max(0, $BurstLines - $landed)
                Write-Output ("    accepted=$accepted landed=$landed lost=$lost (allowed $($batchLines * 2)); completed before kill=$completed")
                Set-Content -LiteralPath (Join-Path $Out 'console-burst.json') -Value (@{
                        accepted = $accepted; landed = $landed; lost = $lost; allowedLost = $batchLines * 2
                        burstLines = $BurstLines; completedBeforeKill = $completed; patchedOut = ($done -and $done.patchedOut); patchedErr = ($done -and $done.patchedErr)
                    } | ConvertTo-Json)
                if ($lost -gt ($batchLines * 2)) {
                    throw "a mid-burst kill lost $lost of $accepted accepted lines (bound $($batchLines * 2))"
                }
                # The accepted counter is written after every chunk, so a kill in
                # the middle of a chunk can also leave that chunk partly unwritten;
                # the log must still hold all but at most two batches of the burst.
                if ($lostOverall -gt ($batchLines * 2 + 4000)) {
                    throw "only $landed of $BurstLines burst lines reached the log"
                }
            } finally {
                & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Stop $consoleName | Out-Null
            }
        }

        Step 'a test server keeps its stall captures in its own root (F3)' {
            $liveBefore = @(Get-ChildItem -LiteralPath $liveStallsDir -Filter 'stall-*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
            $stallName = $Name + 's'
            $stallProbeDir = Join-Path $Out 'stall-probe'
            New-Item -ItemType Directory -Force -Path $stallProbeDir | Out-Null
            $prevNodeOptions = $env:NODE_OPTIONS
            $prevProbeDir = $env:QA_PROBE_DIR
            $stallInfo = $null
            try {
                $env:NODE_OPTIONS = '--require ' + (Join-Path $e2e 'console-burst-probe.cjs')
                $env:QA_PROBE_DIR = $stallProbeDir
                $stallInfo = & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Name $stallName -Release $Release -Json | ConvertFrom-Json
            } finally {
                $env:NODE_OPTIONS = $prevNodeOptions
                $env:QA_PROBE_DIR = $prevProbeDir
            }
            $stallRoot = [string]$stallInfo.Root
            try {
                Set-Content -LiteralPath (Join-Path $stallProbeDir 'stall-a.json') -Value (@{ ms = 1600 } | ConvertTo-Json -Compress)
                $deadline = (Get-Date).AddSeconds(20)
                while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $stallProbeDir 'stall-a.stalled'))) {
                    Start-Sleep -Milliseconds 200
                }
                if (-not (Test-Path -LiteralPath (Join-Path $stallProbeDir 'stall-a.stalled'))) { throw 'the provoked stall never ran' }
                # The recorder writes the capture from a worker; give it a moment.
                $ownDir = Join-Path $stallRoot 'userdata\logs\stalls'
                $deadline = (Get-Date).AddSeconds(30)
                while ((Get-Date) -lt $deadline) {
                    $own = @(Get-ChildItem -LiteralPath $ownDir -Filter 'stall-*.json' -ErrorAction SilentlyContinue)
                    if ($own.Count -gt 0) { break }
                    Start-Sleep -Seconds 1
                }
                $own = @(Get-ChildItem -LiteralPath $ownDir -Filter 'stall-*.json' -ErrorAction SilentlyContinue)
                # The capture names its own pid, so a leak into the live folder is
                # identifiable exactly: only this test server's pid counts, never a
                # real live stall that happens to land during the same window.
                $stallServerPid = [int]$stallInfo.Server
                $liveAfter = @(Get-ChildItem -LiteralPath $liveStallsDir -Filter 'stall-*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
                $newLive = @($liveAfter | Where-Object { $liveBefore -notcontains $_ })
                $liveLeaks = @()
                foreach ($entry in $newLive) {
                    $path = Join-Path $liveStallsDir $entry
                    try {
                        $capturePid = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).pid
                        if ([int]$capturePid -eq $stallServerPid) { $liveLeaks += $entry }
                    } catch {
                        # An unreadable capture is not evidence of a leak.
                    }
                }
                Write-Output ("    own captures: $($own.Count) under $ownDir; new live captures: $($newLive.Count); leaks: $($liveLeaks.Count)")
                Set-Content -LiteralPath (Join-Path $Out 'stall-location.json') -Value (@{
                        ownCaptures = $own.Count; ownDir = $ownDir; newLiveCaptures = $newLive; liveLeaks = $liveLeaks
                    } | ConvertTo-Json)
                if ($own.Count -eq 0) { throw "no stall capture landed under the root's own $ownDir" }
                if ($liveLeaks.Count -gt 0) { throw "test server capture(s) leaked into the live stalls dir: $($liveLeaks -join ', ')" }
            } finally {
                & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Stop $stallName | Out-Null
            }
        }
    }

    if (-not $SkipSteer) {
        Step 'steer order on the fake CLI (turn ends before the DB check)' {
            & $nodeExe (Join-Path $e2e 'steer-check.mjs') --origin $info.URL --pair (New-PairLink) --bin $bin --out $Out
            if ($LASTEXITCODE -ne 0) { throw "steer-check exit $LASTEXITCODE" }
        }
        Step 'no pending turn row + idle classifier sees the table' {
            # The 1.66.33 classifier still stands: 1.66.35 changes nothing about
            # pending turn-start rows, so no new copy is minted here (the file the
            # runner installs stays run\idle-classification-16617.mjs).
            & $nodeExe (Join-Path $e2e 'pending-turns-check.mjs') `
                (Join-Path $root 'userdata\state.sqlite') `
                (Join-Path $PSScriptRoot 'idle-classification-16633.mjs') |
                Tee-Object -FilePath (Join-Path $Out 'pending-turns.txt')
            if ($LASTEXITCODE -ne 0) { throw "pending check exit $LASTEXITCODE" }
        }
    }

    if (-not $SkipIsolation) {
        Step 'usage-scan isolation on the Team card' {
            & $nodeExe (Join-Path $e2e 'usage-isolation.mjs') --origin $info.URL --pair (New-PairLink) --bin $bin --out $Out
            if ($LASTEXITCODE -ne 0) { throw "usage-isolation exit $LASTEXITCODE" }
        }
    }

    if (-not $SkipRetention) {
        Step 'provider-log retention really runs on the seeded directory (F2)' {
            & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $e2e 'retention-load-check.ps1') `
                -Release $Release -Name ($Name + 'ret') -Out (Join-Path $Out 'retention') -ThrowawayScript $throwaway
            if ($LASTEXITCODE -ne 0) { throw "retention check exit $LASTEXITCODE" }
        }
    }
} finally {
    if (-not $Keep) {
        Write-Output "=== stopping throwaway '$Name'"
        & $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Stop $Name
    } else {
        Write-Output "=== kept throwaway '$Name' at $($info.URL) (stop: throwaway-server.ps1 -Stop $Name)"
    }
}

Write-Output ''
if ($script:failures.Count -gt 0) {
    Write-Output ("qa-16635 FAILED: " + ($script:failures -join ' | '))
    exit 1
}
Write-Output "qa-16635 all checks passed. Evidence in $Out"
exit 0
