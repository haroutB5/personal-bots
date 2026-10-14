param([string]$Version, [string]$Release, [string]$Commit, [string]$RepoRoot)
$f = Join-Path $env:USERPROFILE '.personal-bots\run\flags'
Add-Content -LiteralPath "$f\calls.log" -Value "evidence $Release"
$c = 0
if (Test-Path "$f\evidence.exit") { $c = [int](Get-Content "$f\evidence.exit" -Raw).Trim() }
if ($c -ne 0) { Write-Host 'FAIL: stub evidence check refused' } else { Write-Host 'PASS: stub evidence' }
exit $c
