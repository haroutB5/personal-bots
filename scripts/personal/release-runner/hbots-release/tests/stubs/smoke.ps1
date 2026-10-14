param([string]$ExpectRelease, [int]$StartTimeoutSeconds, [int]$TunnelTimeoutSeconds, [int]$StableSeconds = 120, [long]$LogFromByte = -1, [string]$LogFile, [switch]$NoTunnel, [string]$Node)
$h = Join-Path $env:USERPROFILE '.personal-bots'
$f = "$h\run\flags"
Add-Content -LiteralPath "$f\calls.log" -Value "smoke $ExpectRelease stable=$StableSeconds"
function Flag([string]$n) { if (Test-Path "$f\$n") { return (Get-Content "$f\$n" -Raw).Trim() } return $null }
$sleep = [Math]::Min($StableSeconds, 4)
Start-Sleep -Seconds $sleep
$ec = Flag "smoke.$ExpectRelease.exit"
if ($ec -and [int]$ec -ne 0) {
    Write-Host '  FAIL  stub smoke failure'
    Write-Host 'Smoke FAILED (1 problem(s)).'
    exit ([int]$ec)
}
Write-Host 'Smoke PASSED (stub).'
exit 0
