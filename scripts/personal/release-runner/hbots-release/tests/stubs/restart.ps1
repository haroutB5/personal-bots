param([string]$Release, [switch]$NoPrune, [string]$Root, [string]$Node, [int]$KeepReleases)
$h = Join-Path $env:USERPROFILE '.personal-bots'
$f = "$h\run\flags"
Add-Content -LiteralPath "$f\calls.log" -Value "restart $Release"
function Flag([string]$n) { if (Test-Path "$f\$n") { return (Get-Content "$f\$n" -Raw).Trim() } return $null }
$ec = Flag "restart.$Release.exit"
if ($ec) { Write-Host 'FAIL stub restart'; exit ([int]$ec) }
Set-Content -LiteralPath "$h\releases\current.txt" -Value $Release -Encoding ASCII
$sj = Get-Content "$h\run\server.json" -Raw | ConvertFrom-Json
$sj.release = $Release
$sj.startedAt = (Get-Date).ToUniversalTime().ToString('o')
$sj | ConvertTo-Json | Set-Content -LiteralPath "$h\run\server.json" -Encoding ASCII
$log = [string]$sj.logFile
Add-Content -LiteralPath $log -Value "[$(Get-Date -Format s)] INFO server started release=$Release"
Add-Content -LiteralPath $log -Value "[$(Get-Date -Format s)] INFO stall recorder on (watchdog 5000 ms) profiler: 'continuous'"
if (Flag 'error-line') { Add-Content -LiteralPath $log -Value "[$(Get-Date -Format s)] ERROR something broke at startup" }
if (Flag 'sql-echo') { Add-Content -LiteralPath $log -Value "      'sql 790 ms INSERT INTO orchestration_command_receipts ( command_id, status, error ) VALUES ...'" }
if (Flag 'token-line') { Add-Content -LiteralPath $log -Value "[$(Get-Date -Format s)] INFO Pairing URL: http://x/pair#token=abc" }
$db = "$h\dev\userdata\state.sqlite"
if (Flag 'drop-memory') { & node --disable-warning=ExperimentalWarning (Join-Path $env:HBOTS_TEST_STUBS 'dbtool.cjs') $db delete-memory }
if (Flag 'normal-priority') {
    $port = [int]$env:HBOTS_TEST_PORT
    $pid2 = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen).OwningProcess | Select-Object -First 1
    (Get-Process -Id $pid2).PriorityClass = 'Normal'
}
Write-Host "stub restart ok -> $Release"
exit 0
