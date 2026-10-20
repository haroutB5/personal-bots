# Isolated real-process tests. Never waits on or abandons the production mutex.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('hbots-heavy-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$wrapper = Join-Path $PSScriptRoot 'heavy-job.ps1'
$lock = 'Local\hbots-heavy-test-' + [guid]::NewGuid().ToString('N')
$state = Join-Path $root 'state.json'
$saved = $env:HBOTS_HEAVY_JOB_HELD
$env:HBOTS_HEAVY_JOB_HELD = $null
$jobs = @()
function Assert([bool]$Value, [string]$Label) { if (-not $Value) { throw "FAIL $Label" }; Write-Host "ok $Label" }
function Launch([string]$Command, [string]$Suffix) {
    $args = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Label test -MutexName "{1}" -StateFile "{2}" -WorkDir "{3}" -Command "{4}"' -f $wrapper,$lock,$state,$root,$Command
    $p = Start-Process powershell.exe -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root "$Suffix.out") -RedirectStandardError (Join-Path $root "$Suffix.err")
    $null = $p.Handle
    return $p
}
try {
    # Exit propagation, including Script mode's switches, arrays and literal quotes.
    $p = Launch 'exit /b 37' 'exit'; $jobs += $p; $p.WaitForExit()
    Assert ($p.ExitCode -eq 37) 'command exit code 37 preserved'
    $script = Join-Path $root 'args.ps1'
    Set-Content -LiteralPath $script -Value 'param([switch]$Flag,[string[]]$Items); if (-not $Flag -or $Items[0] -ne ''a b'' -or $Items[1] -ne ''c"d'') { exit 9 }; exit 23'
    & $wrapper -Label args -MutexName $lock -StateFile $state -ScriptPath $script -ScriptParameters @{ Flag = $true; Items = @('a b','c"d') }
    Assert ($LASTEXITCODE -eq 23) 'script arguments and exit code preserved'
    $env:HBOTS_HEAVY_JOB_HELD = $null
    # Parent test thread owns the isolated mutex while a real child waits.
    $mutex = New-Object Threading.Mutex($true, $lock)
    $p = Launch 'echo entered>entered.txt' 'wait'; $jobs += $p
    Start-Sleep -Seconds 2
    Assert (-not $p.HasExited -and -not (Test-Path (Join-Path $root 'entered.txt'))) 'second process waits'
    $mutex.ReleaseMutex(); $mutex.Dispose()
    Assert ($p.WaitForExit(15000) -and $p.ExitCode -eq 0) 'waiting process runs after release'
    $env:HBOTS_HEAVY_JOB_HELD = '1'
    $mutex = New-Object Threading.Mutex($true, $lock)
    $p = Launch 'exit /b 17' 'nested'; $jobs += $p
    Assert ($p.WaitForExit(15000) -and $p.ExitCode -eq 17) 'nested call bypasses lock'
    $mutex.ReleaseMutex(); $mutex.Dispose()
    $env:HBOTS_HEAVY_JOB_HELD = $null
    # A terminated owner abandons a mutex still referenced by this test.
    $mutex = New-Object Threading.Mutex($false, $lock)
    $abandon = Join-Path $root 'abandon.ps1'
    Set-Content -LiteralPath $abandon -Value ('param($Name,$Ready); $m=New-Object Threading.Mutex($false,$Name); $null=$m.WaitOne(); Set-Content $Ready ready; Start-Sleep -Seconds 30')
    $ready = Join-Path $root 'ready'
    $owner = Start-Process powershell.exe -ArgumentList "-NoProfile -File `"$abandon`" -Name `"$lock`" -Ready `"$ready`"" -WindowStyle Hidden -PassThru
    $jobs += $owner
    for ($i=0; $i -lt 100 -and -not (Test-Path $ready); $i++) { Start-Sleep -Milliseconds 100 }
    Assert (Test-Path $ready) 'abandoned owner acquired lock'
    Stop-Process -Id $owner.Id -Force; $owner.WaitForExit()
    $p = Launch 'exit /b 0' 'abandoned'; $jobs += $p
    Assert ($p.WaitForExit(15000) -and $p.ExitCode -eq 0) 'abandoned mutex recovered'
    $mutex.Dispose()
    Assert (-not (Test-Path $state)) 'holder state cleaned'
    Write-Host 'Tests: 8 passed'
} finally {
    $env:HBOTS_HEAVY_JOB_HELD = $saved
    foreach ($p in $jobs) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
    # This generated tree contains only test scripts and logs, no junctions.
    if ((Get-Item -LiteralPath $root).FullName -notlike "$([IO.Path]::GetTempPath())hbots-heavy-test-*") { throw 'Unsafe cleanup target' }
    if (@(Get-ChildItem -LiteralPath $root -Recurse -Attributes ReparsePoint).Count -gt 0) { throw 'Unexpected test junction' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
