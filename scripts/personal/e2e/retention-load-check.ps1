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
    [int]$Files = 120,
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
Write-Output "out: $Out"

# 1. A fresh root, stopped at once.
$info = & $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Name $Name -Release $Release -Json | ConvertFrom-Json
$root = [string]$info.Root
& $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Down $Name | Out-Null

# 2. Many provider-log files: prefix-matching files exercise readdir+stat,
#    others the header read; sizes make a slow disk's stat/read expensive.
$dir = Join-Path $root 'logs\provider'
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
Write-Output "seeded $Files x ${Mb}MB + 40 small files under $dir"

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
} finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $loadDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Keep) { & $ps -NoProfile -ExecutionPolicy Bypass -File $tw -Stop $Name | Out-Null }
}
Write-Output "done; evidence in $Out"
