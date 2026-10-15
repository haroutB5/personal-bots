param([string]$Version, [string]$Commit, [string]$RepoRoot)
$f = Join-Path $env:USERPROFILE '.personal-bots\run\flags'
Add-Content -LiteralPath "$f\calls.log" -Value "notes $Version"
$c = 0
if (Test-Path "$f\notes.exit") { $c = [int](Get-Content "$f\notes.exit" -Raw).Trim() }
if ($c -ne 0) { Write-Host 'FAIL: stub notes check refused' } else { Write-Host 'PASS: stub notes' }
exit $c
