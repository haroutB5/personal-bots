param([string]$ThreadId, [string]$Version, [string]$Release, [string]$Outcome, $SmokeExit, [string]$RollbackRelease, $RollbackExit, $RollbackSmokeExit, [string]$LogPath, [string]$Detail, [string]$Root, [string]$BaseDir)
$f = Join-Path $env:USERPROFILE '.personal-bots\run\flags'
Add-Content -LiteralPath "$f\calls.log" -Value "notify outcome=$Outcome thread=$ThreadId release=$Release smoke=$SmokeExit rollback=$RollbackRelease detail=$Detail"
exit 0
