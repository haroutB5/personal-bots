# Real wrapper, isolated fake home. A failed file copy or snapshot must not publish a
# manifest, prune any previously verified backup or leave its own partial folder, and its
# cleanup must not follow a junction out of that folder.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('pb-backup-failure-' + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $root '.personal-bots'
$state = Join-Path $homeDir 'dev\userdata'
$backups = Join-Path $homeDir 'backups'
$outside = Join-Path $root 'outside'
$link = Join-Path $state 'attachments'
$previousNames = @('20200101-000001', '20200101-000002', '20200101-000003')
$oldProfile = $env:USERPROFILE
$lock = $null

function Invoke-Backup {
    $out = Join-Path $root 'output.txt'
    $err = Join-Path $root 'error.txt'
    $p = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'backup.ps1'), '-Keep', '3') -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle
    if (-not $p.WaitForExit(60000)) { Stop-Process -Id $p.Id -Force; throw 'Wrapper timeout' }
    $p.WaitForExit()
    return [pscustomobject]@{ Code = $p.ExitCode; Out = ((Get-Content $out -Raw) + (Get-Content $err -Raw)) }
}
function Assert-FailedCleanly([string]$Case, $Result) {
    if ($Result.Code -eq 0) { throw "${Case}: backup unexpectedly succeeded" }
    $dirs = @(Get-ChildItem $backups -Directory)
    if ($dirs.Count -ne 3) { throw "${Case}: expected only the 3 previous backups, found $($dirs.Count): $(($dirs | ForEach-Object Name) -join ',')" }
    foreach ($name in $previousNames) {
        if ((Get-Content (Join-Path $backups "$name\state.sqlite") -Raw).Trim() -ne 'previous verified backup') { throw "${Case}: previous backup changed" }
    }
    if ($Result.Out -notmatch 'Removed the partial backup') { throw "${Case}: no removal reported: $($Result.Out)" }
    if ((Get-Content (Join-Path $outside 'keep.txt') -Raw).Trim() -ne 'outside the backup') { throw "${Case}: cleanup followed a junction" }
    Write-Host "PASS: $Case publishes no manifest, removes its partial folder and keeps all previous verified backups."
}

try {
    New-Item -ItemType Directory -Force $state, $backups, $outside | Out-Null
    & node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'release-runner\hbots-release\make-fixture.cjs') (Join-Path $state 'state.sqlite') 106
    if ($LASTEXITCODE -ne 0) { throw 'Fixture failed' }
    foreach ($name in $previousNames) {
        $dir = Join-Path $backups $name
        New-Item -ItemType Directory $dir | Out-Null
        Set-Content (Join-Path $dir 'backup.json') '{}'
        Set-Content (Join-Path $dir 'state.sqlite') 'previous verified backup'
    }
    Set-Content (Join-Path $outside 'keep.txt') 'outside the backup'
    & cmd.exe /d /c mklink /J $link $outside | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'mklink failed' }
    $settings = Join-Path $state 'settings.json'
    Set-Content $settings '{}'
    $env:USERPROFILE = $root

    # 1. the companion-file copy fails after the snapshot was taken
    $lock = [IO.File]::Open($settings, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Assert-FailedCleanly 'file-copy failure' (Invoke-Backup)
    $lock.Dispose(); $lock = $null

    # 2. the snapshot itself fails (a corrupt source)
    $db = Join-Path $state 'state.sqlite'
    Move-Item -LiteralPath $db -Destination "$db.good"
    Set-Content -LiteralPath $db -Value 'not a sqlite database'
    Assert-FailedCleanly 'snapshot failure' (Invoke-Backup)
    Remove-Item -LiteralPath $db
    Move-Item -LiteralPath "$db.good" -Destination $db

    # 3. a good run publishes and keeps its folder
    Start-Sleep -Seconds 1
    $ok = Invoke-Backup
    if ($ok.Code -ne 0) { throw "good backup failed: $($ok.Out)" }
    $fresh = @(Get-ChildItem $backups -Directory | Where-Object { $_.Name -notlike '20200101-*' })
    if ($fresh.Count -ne 1 -or -not (Test-Path (Join-Path $fresh[0].FullName 'backup.json'))) { throw 'good backup did not publish its folder' }
    Write-Host 'PASS: a good backup publishes backup.json and keeps its folder.'
} finally {
    if ($lock) { $lock.Dispose() }
    $env:USERPROFILE = $oldProfile
    if (Test-Path -LiteralPath $link) { & cmd.exe /d /c rmdir $link }
    $resolved = [IO.Path]::GetFullPath($root)
    if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $resolved -Leaf) -like 'pb-backup-failure-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
