<#
.SYNOPSIS
The 1.66.33 R3 measurement: the provider-log retention pass must not block the event loop at boot.

.DESCRIPTION
Boots a throwaway once (to make the root), stops it, fills the root's provider-log directory with
many files (the live directory held 77 files / 532 MB), then boots it again under a disk-load
generator and reads the stall recorder lines (e2e\stall-report.mjs): the old synchronous pass
(openSync/readSync/statSync over every file) shows up as a statSync/readdir stall of 1 s or more;
the async pass shows no such stall. Run it on the old release and the new one and compare.
Heavy load: not between 23:00 and 07:00, not while a release waiter is armed.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e\retention-load-check.ps1 -Release 3e97a7b456cc -ThrowawayScript C:\Claude\AI\personal-bots\scripts\personal\throwaway-server.ps1 -Out $env:TEMP\retention-before
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [string]$Name = 'qa16633ret',
    # 150 x 4 MB = 600 MB seeded, over the 512 MB cap, so the size trim runs too
    # (the QA F2 re-run measured exactly this shape: 600 MB -> 512 MB).
    [int]$Files = 150,
    [int]$Mb = 4,
    [string]$Out = '',
    [string]$ThrowawayScript = '',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'common.ps1')

if (-not $Out) { $Out = Join-Path $env:TEMP ('hbots-retention-' + (Get-Date -Format 'HHmmss')) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$ps = Join-Path $PSHOME 'powershell.exe'
$tw = if ($ThrowawayScript) { $ThrowawayScript } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'throwaway-server.ps1' }
$nodeExe = Resolve-NodeExe
$script:retentionProblems = @()
Write-Output "out: $Out"

# 1. A fresh root, stopped at once.
$info = & $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Name $Name -Release $Release -Json | ConvertFrom-Json
$root = [string]$info.Root
& $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Down $Name | Out-Null

# 2. Many provider-log files: prefix-matching files exercise readdir+stat,
#    others the header read; sizes make a slow disk's stat/read expensive.
#    The server reads <baseDir>\userdata\logs\provider (config.ts: stateDir/logs/provider);
#    seeding <root>\logs\provider seeds a directory nothing reads (QA 1.66.33 F2), so
#    this path must stay the userdata one or the check proves nothing about the pass.
$dir = Join-Path $root 'userdata\logs\provider'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$chunk = New-Object byte[] (1MB)
[System.Random]::new(11).NextBytes($chunk)
for ($i = 0; $i -lt $Files; $i++) {
    $fs = [System.IO.File]::Create((Join-Path $dir "events.log.$i"))
    try { for ($k = 0; $k -lt $Mb; $k++) { $fs.Write($chunk, 0, $chunk.Length); $fs.Flush() } } finally { $fs.Dispose() }
}
for ($i = 0; $i -lt 40; $i++) {
    [System.IO.File]::WriteAllText((Join-Path $dir "thread-$i.log"), ('[2026-10-12T00:00:0' + ($i % 10) + '.000Z] NTIVE: x'))
}
# Six dated files with the provider prefix and header: the retention pass must
# remove these for age (older than 14 days) while leaving unrelated files alone.
# The names must satisfy the pass's own filter (isProviderLogFileAsync: name
# ends .log or .log.<digits>, and starts with the "events.log." prefix or holds
# an NTIVE/CANON/ORCH header), or the pass never looks at them at all - the
# first version of this check used "events.log.stale0" and they survived.
$stale = (Get-Date).AddDays(-20)
for ($i = 0; $i -lt 6; $i++) {
    $staleFile = Join-Path $dir ("events.log.{0}" -f (900000 + $i))
    [System.IO.File]::WriteAllText($staleFile, '[2026-09-01T00:00:00.000Z] NTIVE: x')
    (Get-Item -LiteralPath $staleFile).LastWriteTime = $stale
}
[System.IO.File]::WriteAllText((Join-Path $dir 'unrelated.txt'), 'keep me')
[System.IO.File]::WriteAllText((Join-Path $dir 'notes.log'), 'keep me too')
$seededBytes = (Get-ChildItem -LiteralPath $dir -File | Measure-Object -Property Length -Sum).Sum
Write-Output "seeded $Files x ${Mb}MB + 40 small files under $dir ($([math]::Round($seededBytes / 1MB, 1)) MB total)"

# 3. Disk load, then boot and read the stalls.
$loadDir = Join-Path $env:TEMP 'hbots-load-16633'
New-Item -ItemType Directory -Force -Path $loadDir | Out-Null
$job = Start-Job -ArgumentList $loadDir -ScriptBlock {
    param($dir)
    $rng = [System.Random]::new(7)
    $chunk = New-Object byte[] 16777216
    $rng.NextBytes($chunk)
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $file = Join-Path $dir ('load-{0}.bin' -f ($rng.Next()))
        $fs = [System.IO.File]::Create($file)
        try { for ($i = 0; $i -lt 40; $i++) { $fs.Write($chunk, 0, $chunk.Length); $fs.Flush($true) } } finally { $fs.Dispose() }
        Remove-Item -LiteralPath $file -Force
    }
}
Start-Sleep -Seconds 3
try {
    $up = & $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Up $Name
    Write-Output ($up | Out-String).Trim()
    Start-Sleep -Seconds 5
    $bin = (Get-Content -LiteralPath (Join-Path $root 'throwaway.json') -Raw | ConvertFrom-Json).bin
    & $nodeExe (Join-Path $PSScriptRoot 'stall-report.mjs') (Join-Path $root 'server.log') |
        Tee-Object -FilePath (Join-Path $Out 'retention-stall-report.txt')

    # 4. The pass must have RUN on this directory, not merely gone quiet: the
    #    stale provider files (prefix + header + older than 14 days) gone, the
    #    total trimmed to the 512 MiB cap, unrelated files untouched. The stall
    #    report alone cannot tell "async and fast" from "never ran" (QA F2).
    $after = Get-ChildItem -LiteralPath $dir -File
    $afterBytes = ($after | Measure-Object -Property Length -Sum).Sum
    $staleLeft = @($after | Where-Object { $_.Name -match '^events\.log\.9\d{5}$' }).Count
    $eventsLeft = @($after | Where-Object { $_.Name -like 'events.log.*' }).Count
    $unrelatedKept = (Test-Path -LiteralPath (Join-Path $dir 'unrelated.txt')) -and (Test-Path -LiteralPath (Join-Path $dir 'notes.log'))
    $capBytes = 512MB
    $problems = @()
    if ($staleLeft -ne 0) { $problems += "$staleLeft stale provider file(s) survived the age rule" }
    if ($afterBytes -gt $capBytes) { $problems += "provider log dir still holds $([math]::Round($afterBytes / 1MB, 1)) MB (cap 512 MB)" }
    if (-not $unrelatedKept) { $problems += 'unrelated.txt / notes.log were removed' }
    if ($afterBytes -ge $seededBytes) { $problems += 'nothing was removed at all (the pass did not run)' }
    $eventCount = @(Get-ChildItem -LiteralPath $dir -File -Filter 'events.log.*').Count
    Write-Output ("retention after boot: {0} files / {1} MB (seeded {2} MB); age-removed stale={3}; unrelated kept={4}" -f `
            $after.Count, [math]::Round($afterBytes / 1MB, 1), [math]::Round($seededBytes / 1MB, 1), (6 - $staleLeft), $unrelatedKept)
    Set-Content -LiteralPath (Join-Path $Out 'retention-after.json') -Value (@{
            seededBytes = $seededBytes; afterBytes = $afterBytes; afterFiles = $after.Count
            eventsLeft = $eventCount; staleLeft = $staleLeft; unrelatedKept = $unrelatedKept
        } | ConvertTo-Json)
    if ($problems.Count -gt 0) {
        $script:retentionProblems = $problems
    }
} finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $loadDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Keep) { & $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Stop $Name | Out-Null }
}
if ($script:retentionProblems.Count -gt 0) {
    Write-Output ("retention check FAILED: " + ($script:retentionProblems -join '; '))
    Write-Output "evidence in $Out"
    exit 1
}
Write-Output "retention check passed; evidence in $Out"
