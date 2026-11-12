/**
 * The script the gaming PC runs, sent over ssh stdin (see gamingPc.ts). A
 * compile-time constant: nothing from a request, a client or the environment
 * is ever put into it.
 *
 * Read-only on the PC. It reads `S:\hbots\games.txt` and
 * `S:\hbots\light-games.txt` if present (the lists the rig's game check
 * uses), reads three performance counters and the process names, and writes one
 * JSON line to stdout. It writes nothing, installs nothing and kills nothing.
 * It ends by itself after `$MaxLines` readings (24 lines, about 2 minutes) and
 * a watchdog runspace exits the process after 170 s whatever the main thread is
 * doing, so neither a dropped laptop link nor a stalled counter call can leave
 * it running.
 *
 * Source of truth for review: qa/hbots-gamingpc-stats/pcstats-final.ps1.
 *
 * Counters (measured 12 Nov on the gaming PC):
 * - CPU: \Processor Information(_Total)\% Processor Utility, capped at 100.
 * - RAM: total from Win32_ComputerSystem, free from \Memory\Available MBytes.
 * - GPU: the busiest 3D engine of \GPU Engine(*engtype_3D), capped at 100.
 */
export const PC_STATS_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$MaxLines = 24
# Hard deadline for the whole run, even if a counter call stalls before the first line.
$wd = [powershell]::Create()
[void]$wd.AddScript('Start-Sleep -Seconds 170; [Environment]::Exit(0)')
[void]$wd.BeginInvoke()
$heavy = @(); $light = @()
if (Test-Path -LiteralPath 'S:\hbots\games.txt') {
  $heavy = @(Get-Content -LiteralPath 'S:\hbots\games.txt' | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $_ -replace '\.exe$', '' })
}
if (Test-Path -LiteralPath 'S:\hbots\light-games.txt') {
  $light = @(Get-Content -LiteralPath 'S:\hbots\light-games.txt' | ForEach-Object {
    if ($_.Trim() -match '^(ingame|client)\s*:\s*(.+)$') { [pscustomobject]@{ Kind = $Matches[1].ToLower(); Name = ($Matches[2].Trim() -replace '\.exe$', '') } } })
}
$totalMb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$paths = @('\Processor Information(_Total)\% Processor Utility', '\Memory\Available MBytes', '\GPU Engine(*engtype_3D)\Utilization Percentage')
$n = 0
while ($true) {
  $set = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 1
  $cpu = $null; $availMb = $null; $eng = @{}
  foreach ($s in $set.CounterSamples) {
    if ($s.Status -ne 0) { continue }
    if ($s.Path -like '*processor utility') { $cpu = [math]::Min(100, [math]::Round($s.CookedValue)) }
    elseif ($s.Path -like '*available mbytes') { $availMb = [int]$s.CookedValue }
    elseif ($s.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)') { $k = $Matches[0]; $eng[$k] = [double]$eng[$k] + $s.CookedValue }
  }
  $gpu = if ($eng.Count -gt 0) { [math]::Min(100, [math]::Round(($eng.Values | Measure-Object -Maximum).Maximum)) } else { $null }
  $names = @(Get-Process | ForEach-Object { $_.ProcessName })
  $game = $null
  $h = $heavy | Where-Object { $names -contains $_ } | Select-Object -First 1
  if ($h) { $game = @{ kind = 'game'; process = $h } } else {
    $m = $light | Where-Object { $_.Kind -eq 'ingame' -and $names -contains $_.Name } | Select-Object -First 1
    if ($m) { $game = @{ kind = 'match'; process = $m.Name } } else {
      $c = $light | Where-Object { $_.Kind -eq 'client' -and $names -contains $_.Name } | Select-Object -First 1
      if ($c) { $game = @{ kind = 'client'; process = $c.Name } } } }
  try {
    [Console]::Out.WriteLine(([pscustomobject]@{ v = 1; cpuPct = $cpu; memAvailMb = $availMb; memTotalMb = $totalMb; gpuPct = $gpu; game = $game } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch { exit 0 }
  $n++
  if ($n -ge $MaxLines) { exit 0 }
  Start-Sleep -Seconds 4
}
`;
