# Real wrapper, isolated fake home. A file-copy failure must not publish a
# manifest or prune any previously verified backup.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('pb-backup-failure-' + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $root '.personal-bots'
$state = Join-Path $homeDir 'dev\userdata'
$backups = Join-Path $homeDir 'backups'
$oldProfile = $env:USERPROFILE
$lock = $null
try {
 New-Item -ItemType Directory -Force $state, $backups | Out-Null
 & node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'release-runner\hbots-release\make-fixture.cjs') (Join-Path $state 'state.sqlite') 106
 if ($LASTEXITCODE -ne 0) { throw 'Fixture failed' }
 foreach ($name in @('20200101-000001','20200101-000002','20200101-000003')) {
  $dir = Join-Path $backups $name
  New-Item -ItemType Directory $dir | Out-Null
  Set-Content (Join-Path $dir 'backup.json') '{}'
  Set-Content (Join-Path $dir 'state.sqlite') 'previous verified backup'
 }
 $settings = Join-Path $state 'settings.json'
 Set-Content $settings '{}'
 $lock = [IO.File]::Open($settings, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
 $env:USERPROFILE = $root
 $out = Join-Path $root 'output.txt'
 $err = Join-Path $root 'error.txt'
 $p = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', (Join-Path $PSScriptRoot 'backup.ps1'),'-Keep','3') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
 $null = $p.Handle
 if (-not $p.WaitForExit(15000)) { Stop-Process -Id $p.Id -Force; throw 'Wrapper timeout' }
 $p.WaitForExit()
 if ($p.ExitCode -eq 0) { throw 'Locked settings copy unexpectedly succeeded' }
 $dirs = @(Get-ChildItem $backups -Directory)
 if ($dirs.Count -ne 4) { throw "Previous backups pruned during failure ($($dirs.Count) dirs)" }
 $fresh = @($dirs | Where-Object { $_.Name -notlike '20200101-*' })
 if (Test-Path (Join-Path $fresh[0].FullName 'backup.json')) { throw 'Failed backup published a manifest' }
 foreach ($name in @('20200101-000001','20200101-000002','20200101-000003')) {
  if ((Get-Content (Join-Path $backups "$name\state.sqlite") -Raw).Trim() -ne 'previous verified backup') { throw 'Previous backup changed' }
 }
 Write-Host 'PASS: file-copy failure publishes no manifest and keeps all previous verified backups.'
} finally {
 if ($lock) { $lock.Dispose() }
 $env:USERPROFILE = $oldProfile
 $resolved = [IO.Path]::GetFullPath($root)
 if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and
     (Split-Path $resolved -Leaf) -like 'pb-backup-failure-*') {
  Remove-Item -LiteralPath $resolved -Recurse -Force
 }
}
