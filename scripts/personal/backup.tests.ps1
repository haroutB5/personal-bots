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

function Invoke-Backup([switch]$DefaultKeep) {
    $out = Join-Path $root 'output.txt'
    $err = Join-Path $root 'error.txt'
    # -DefaultKeep passes no -Keep, so backup.ps1's own default (3, Harout 20 Oct) is what prunes.
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'backup.ps1'))
    if (-not $DefaultKeep) { $argList += @('-Keep', '3') }
    $p = Start-Process powershell -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
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

    # 4. the default keeps the newest 3 timestamp backups and never touches a pre-* migration backup or a stray file
    $defaultKeep = [int](([regex]::Match((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'backup.ps1') -Raw), '\$Keep\s*=\s*(\d+)')).Groups[1].Value)
    if ($defaultKeep -ne 3) { throw "backup.ps1 default -Keep is $defaultKeep, expected 3" }
    $pre = Join-Path $backups 'pre-migration-keepme'
    New-Item -ItemType Directory $pre | Out-Null
    Set-Content (Join-Path $pre 'backup.json') '{}'
    Set-Content (Join-Path $pre 'state.sqlite') 'pre-migration backup'
    Set-Content (Join-Path $backups 'stray-file.txt') 'stray'
    foreach ($name in '20200101-000004', '20200101-000005') {
        New-Item -ItemType Directory (Join-Path $backups $name) | Out-Null
        Set-Content (Join-Path (Join-Path $backups $name) 'backup.json') '{}'
    }
    Start-Sleep -Seconds 2
    $before = @(Get-ChildItem $backups -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' }).Count
    $def = Invoke-Backup -DefaultKeep
    if ($def.Code -ne 0) { throw "default-keep backup failed: $($def.Out)" }
    $ts = @(Get-ChildItem $backups -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name)
    if ($before -le 3) { throw "default-keep case needs more than 3 backups before the run (had $before)" }
    if ($ts.Count -ne 3) { throw "default keep left $($ts.Count) timestamp backups, expected 3: $(($ts | ForEach-Object Name) -join ',')" }
    if (-not (Test-Path (Join-Path $ts[-1].FullName 'backup.json'))) { throw 'the newest backup is not the fresh published one' }
    if ($ts[0].Name -ne '20200101-000005') { throw "default keep should leave the newest old backup first, found: $(($ts | ForEach-Object Name) -join ',')" }
    if ((Get-Content (Join-Path $pre 'state.sqlite') -Raw).Trim() -ne 'pre-migration backup') { throw 'the pre-* migration backup was touched' }
    if (-not (Test-Path (Join-Path $backups 'stray-file.txt'))) { throw 'a non-timestamp entry was removed' }
    Write-Host 'PASS: the default -Keep is 3, it prunes only older timestamp backups and leaves pre-* backups and stray files alone.'
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
