<#
.SYNOPSIS
The scripted 1.66.33 checks on a throwaway server: the stall load measurement, the stale-pending-turn check (B) and the usage-scan isolation check (C).

.DESCRIPTION
Starts a fresh throwaway root (throwaway-server.ps1, fake Claude CLIs, Sonnet seed), then runs:
  -Load     : a disk-load generator on the same volume while a scripted phone drives the two hot
              paths (the Usage card's "Refresh usage" = rpc:server.refreshProviders, and a streaming
              SLOW bot turn), then reads the server log's stall recorder lines. FAILS when any
              sync-fs-walk or spawn stall ran 1 s or longer (scripts\personal\e2e\stall-load.mjs +
              stall-report.mjs). This is the before/after harness: run it on the old release and the
              new one and compare.
  -Steer    : the real steer order on the fake CLI (slow turn, tap-send a second message mid-turn,
              turn ends) and then the database check: no pending turn-start row may remain, and the
              release's idle-classification-16633.mjs must see the table (pending counts 0).
  -Isolation: opens the Team screen's Token usage card on the fresh root: the scan must find NO
              tokens anywhere, which fails if it read this PC's real Claude/OpenCode/DeepSeek homes
              (QA 1.66.29 saw OpenCode 84.2M on a throwaway before the fix).
Needs WebKit (playwright-core from the release's own node_modules; same rig as the e2e smoke).
The throwaway is stopped with -Stop at the end (also on failure) unless -Keep is given.
Heavy load: do not run between 23:00 and 07:00 or while a release waiter is armed.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16633.ps1 -Release C:\Claude\AI\_wt\hbots-16633
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\qa-16633.ps1 -Release 3e97a7b456cc -SkipSteer -SkipIsolation
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [string]$Name = 'qa16633',
    # Refresh-loop seconds. Deliberately under the 30 s resolution-cache TTL:
    # the loop measures repeated resolutions (where the live stalls came from),
    # after one warm-up refresh the fixed server resolves into the cache.
    [int]$LoadSeconds = 28,
    [string]$Out = '',
    # Which throwaway-server.ps1 to start from (a baseline run against the
    # previous release passes that release's own copy, which does not isolate
    # usage homes - the C check must then fail, proving it detects the leak).
    [string]$ThrowawayScript = '',
    [switch]$SkipLoad,
    [switch]$SkipSteer,
    [switch]$SkipIsolation,
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
    $script:pairCounter += 1
    $text = (& $ps -NoProfile -ExecutionPolicy Bypass -File $throwaway -Pair $Name | Out-String)
    $url = [regex]::Match($text, 'https?://\S+').Value
    if (-not $url) { throw "no pairing link in: $text" }
    # Write-Host, not Write-Output: the return value must be the URL alone.
    Write-Host "    pairing link $($script:pairCounter) minted"
    return $url
}

if (-not $Out) { $Out = Join-Path $env:TEMP ('hbots-qa16633-' + (Get-Date -Format 'HHmmss')) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Output "out: $Out"

$nodeExe = Resolve-NodeExe
$throwaway = if ($ThrowawayScript) { $ThrowawayScript } else { Join-Path $PSScriptRoot 'throwaway-server.ps1' }
if (-not (Test-Path -LiteralPath $throwaway -PathType Leaf)) { throw "no throwaway-server.ps1 at $throwaway" }
$e2e = Join-Path $PSScriptRoot 'e2e'
$ps = Join-Path $PSHOME 'powershell.exe'

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
    $dir = Join-Path $env:TEMP 'hbots-load-16633'
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
                foreach ($job in $jobs) {
                    Wait-Job -Job $job -Timeout ([Math]::Max(60, $LoadSeconds)) | Out-Null
                    Stop-Job -Job $job -ErrorAction SilentlyContinue
                    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath (Join-Path $env:TEMP 'hbots-load-16633') -Recurse -Force -ErrorAction SilentlyContinue
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

    if (-not $SkipSteer) {
        Step 'steer order on the fake CLI' {
            & $nodeExe (Join-Path $e2e 'steer-check.mjs') --origin $info.URL --pair (New-PairLink) --bin $bin --out $Out
            if ($LASTEXITCODE -ne 0) { throw "steer-check exit $LASTEXITCODE" }
        }
        Step 'no pending turn row + idle classifier sees the table' {
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
    Write-Output ("qa-16633 FAILED: " + ($script:failures -join ' | '))
    exit 1
}
Write-Output "qa-16633 all checks passed. Evidence in $Out"
exit 0
