<#
.SYNOPSIS
    Capture the laptop before Omarchy replaces Windows, onto Harout's SanDisk SSD.

.DESCRIPTION
    Default is a DRY RUN: every command is printed, nothing is written.
    Install night needs -Apply and the typed confirmation WIPE-LAPTOP-CONFIRMED.
    -Practice does the same copy without the phrase, while hbots keeps running;
    that copy becomes the seed for install night, which only syncs changes.

    The destination is Harout's external SSD (SanDisk Extreme, NTFS), found by
    model and serial, never by drive letter. The script writes ONLY inside
    <drive>:\hbots-omarchy-backup. It never formats, moves or deletes anything
    else on the drive, and it refuses the drive when the identity does not
    match. No second copy is made anywhere (Harout, 25 Oct).

    What -Apply -Practice do, in order:
      1. Resolve and verify the SSD (model, serial, label, NTFS, USB, free space).
      2. Copy C:\Claude, ~\.personal-bots, ~\.ssh and ~\.cloudflared into
         <folder>\plain. Regenerable folders (node_modules, build output,
         caches, old releases, runtimes, workspace, backups) are left behind.
      3. Snapshot the live hbots database with SQLite's ONLINE backup API
         (node:sqlite backup plus a full integrity check), so hbots keeps
         running. No stop is needed; robocopy skips the live database files.
      4. SHA256 verification of every copied file, plus a manifest CSV. A file
         that changes while it is copied (live logs) is re-copied once and, if it
         still changes, listed in inventory\unstable.txt instead of failing.
      5. Inventory: winget list, tool versions, scheduled tasks, firewall rules
         and ports, Brave profiles, system info, disk identity, and exactly what
         is left behind.
      6. Payload for the one-paste first login: the Linux scripts, the sealed
         secrets bundle when it exists, a hash manifest, PASTE-ME.txt, and the
         restore copy itself. first-login.sh verifies all of it on the laptop.

    The default is data-only (Harout, 25 Oct: only our data and what hbots
    needs). There is no disk image at all: data only, by Harout's decision.

    -Scope Small copies and hashes only a fixture tree under -FixtureRoot with
    -AllowAnyTarget. It is for tests; it never touches a real profile or disk.

    -SelfTest runs argument validation plus a copy/hash round trip in a temp
    folder and exits 0 or 1. It touches nothing outside %TEMP%.

    Secrets: this script never opens, parses, prints or logs .env files or the
    contents of secrets folders. They are copied as opaque bytes and hashed like
    every other file. Hash manifests contain file names and hashes only.

.PARAMETER Target
    Destination folder. Empty (default) resolves the SSD by serial to
    <drive>:\hbots-omarchy-backup. A different explicit path is refused unless
    -AllowAnyTarget is given (tests only).

.PARAMETER Practice
    Do the real copy now without the install-night confirmation phrase. hbots
    keeps running. Safe to repeat: the copy is incremental.

.PARAMETER StopServer
    Also stop hbots with scripts/personal/stop.ps1. Not needed: the database is
    snapshotted with the online backup API.

.PARAMETER SkipDatabase
    Do not refresh the database snapshot. Only for a repair run.

.PARAMETER SkipPayload
    Do not write the one-paste payload or PASTE-ME.txt.

.PARAMETER SecretsBundle
    Use an existing sealed bundle instead of exporting a new one. When empty
    (default), install night exports one into <target>\secrets.bundle and asks
    for the passphrase locally, twice, hidden.

.PARAMETER SkipSecretsExport
    Never export a bundle. The payload then carries no keys and the bots start
    without their saved secrets.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1 -Practice

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1 -Apply
#>
[CmdletBinding()]
param(
    [ValidateSet('Full', 'Small')]
    [string]$Scope = 'Full',

    [string]$Target = '',

    [string]$BackupFolderName = 'hbots-omarchy-backup',

    [string]$VolumeSerial = '2306CQ402457',

    [string]$VolumeModel = 'SanDisk Extreme 55AE',

    [string]$VolumeLabel = 'New Volume',

    [string]$SourceClaude = 'C:\Claude',

    [string]$SourceData = (Join-Path $env:USERPROFILE '.personal-bots'),

    [string]$SecretsBundle = '',

    [string]$RepoRoot = '',

    [switch]$StopServer,

    [switch]$SkipDatabase,

    [switch]$SkipPayload,

    [switch]$SkipSecretsExport,

    [switch]$Practice,

    [switch]$Apply,

    [switch]$AllowAnyTarget,

    [string]$ConfirmText = '',

    [string]$FixtureRoot = '',

    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$script:ConfirmPhrase = 'WIPE-LAPTOP-CONFIRMED'
$script:RepoRoot = $RepoRoot
$script:Started = Get-Date
$script:Timings = [ordered]@{}
$script:Unstable = New-Object System.Collections.Generic.List[string]
$script:VolumeInfo = $null

# Regenerable folders are not copied: bootstrap rebuilds them (pnpm install,
# builds, caches). personal-bots keeps only the live release; old releases,
# backups, runtimes and the workspace are regenerable.
$script:ExcludeDirNames = @(
    'node_modules', 'dist', 'build', 'out', '.next', '.turbo', '.venv',
    '__pycache__', '.cache', '.pnpm-store', 'playwright-browsers', 'coverage',
    'backups', 'runtimes', 'workspace'
)
$script:ExcludeDirs = @()

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Plan {
    param([string]$Message)
    Write-Host "    $Message"
}

function Write-DryCommand {
    param([string]$Command)
    Write-Host '    command:'
    Write-Host "      $Command"
}

function ConvertTo-LongPath {
    param([string]$Path)
    if ($Path.StartsWith('\\?\')) { return $Path }
    if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
    return '\\?\' + $Path
}

function Get-Sha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $long = ConvertTo-LongPath $Path
    $stream = [System.IO.File]::Open($long, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $bytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Test-ExcludedDir {
    param([string]$Path)
    $leaf = [System.IO.Path]::GetFileName($Path)
    foreach ($name in $script:ExcludeDirNames) {
        if ($leaf -ieq $name) { return $true }
    }
    $full = $Path
    if ($full.StartsWith('\\?\')) { $full = $full.Substring(4) }
    $full = [System.IO.Path]::GetFullPath($full)
    foreach ($excluded in $script:ExcludeDirs) {
        if ($full -ieq [System.IO.Path]::GetFullPath($excluded)) { return $true }
    }
    return $false
}

function Get-ReleaseExclusions {
    param([string]$Source, [string]$Keep)
    # Keep only the one release the Linux install will run.
    $result = @()
    $releases = Join-Path $Source 'releases'
    $current = Join-Path $releases 'current.txt'
    if (-not (Test-Path -LiteralPath $current -PathType Leaf)) { return $result }
    $active = $Keep
    if ([string]::IsNullOrWhiteSpace($active)) {
        $active = (Get-Content -LiteralPath $current -Raw).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($active)) { return $result }
    foreach ($dir in [System.IO.Directory]::EnumerateDirectories((ConvertTo-LongPath $releases))) {
        $name = [System.IO.Path]::GetFileName($dir)
        if ($name -ine $active) {
            # Strip the \\?\ prefix: robocopy's /XD does not match it.
            if ($dir.StartsWith('\\?\')) { $result += $dir.Substring(4) }
            else { $result += $dir }
        }
    }
    return $result
}

function Get-TreeFiles {
    param([string]$Root)
    $result = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push((ConvertTo-LongPath $Root))

    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        try {
            foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($dir)) {
                try {
                    $attributes = [System.IO.File]::GetAttributes($entry)
                    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        continue
                    }
                    if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                        if (Test-ExcludedDir $entry) { continue }
                        $stack.Push($entry)
                    }
                    else {
                        $result.Add([System.IO.FileInfo]::new($entry))
                    }
                }
                catch {
                    continue
                }
            }
        }
        catch {
            continue
        }
    }

    return $result
}

function Get-PathSizeBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { return [long]$item.Length }
    $total = [long]0
    foreach ($file in (Get-TreeFiles -Root $Path)) {
        $total += [long]$file.Length
    }
    return $total
}

function Format-Bytes {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

function Get-FreeSpaceBytes {
    param([string]$Path)
    try {
        if ($Path.StartsWith('\\')) {
            $match = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
                Where-Object { $Path.StartsWith($_.Root, [System.StringComparison]::OrdinalIgnoreCase) } |
                Select-Object -First 1
            if ($null -ne $match -and $null -ne $match.Free) { return [long]$match.Free }
            return $null
        }
        $full = [System.IO.Path]::GetFullPath($Path)
        $root = [System.IO.Path]::GetPathRoot($full)
        $drive = New-Object System.IO.DriveInfo($root)
        return [long]$drive.AvailableFreeSpace
    }
    catch {
        return $null
    }
}

function Test-IsUnderPath {
    param([string]$Child, [string]$Parent)
    $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
    $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-BackupVolumeCandidates {
    $result = @()
    foreach ($volume in (Get-Volume -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace([string]$volume.DriveLetter)) { continue }
        $partition = Get-Partition -DriveLetter $volume.DriveLetter -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $partition) { continue }
        $disk = Get-Disk -Number $partition.DiskNumber -ErrorAction SilentlyContinue
        $result += [pscustomobject]@{
            DriveLetter     = [string]$volume.DriveLetter
            Root            = ([string]$volume.DriveLetter + ':\')
            FileSystemLabel = [string]$volume.FileSystemLabel
            FileSystem      = [string]$volume.FileSystem
            Size            = [long]$volume.Size
            SizeRemaining   = [long]$volume.SizeRemaining
            Disk            = $disk
        }
    }
    return $result
}

function Select-BackupVolume {
    param(
        [object[]]$Volumes,
        [string]$Serial,
        [string]$Model,
        [string]$Label
    )

    $found = @()
    foreach ($volume in $Volumes) {
        if ($null -eq $volume.Disk) { continue }
        $serialOk = ([string]$volume.Disk.SerialNumber).Trim() -eq $Serial.Trim()
        $modelOk = ([string]$volume.Disk.FriendlyName) -like ('*' + $Model + '*')
        $labelOk = ([string]$volume.FileSystemLabel) -eq $Label
        $fsOk = ([string]$volume.FileSystem) -eq 'NTFS'
        $busOk = ([string]$volume.Disk.BusType) -eq 'USB'
        if ($serialOk -and $modelOk -and $labelOk -and $fsOk -and $busOk) { $found += $volume }
    }

    if ($found.Count -eq 0) {
        $seen = @($Volumes | ForEach-Object {
            '{0}: {1} {2} {3} serial={4}' -f $_.DriveLetter, $_.FileSystemLabel, $_.FileSystem, $_.Disk.FriendlyName, ([string]$_.Disk.SerialNumber).Trim()
        })
        throw ("The external SSD was not found (want {0}, serial {1}, label {2}, NTFS, USB). Plug it in. Volumes seen:`n  {3}" -f $Model, $Serial, $Label, ($seen -join "`n  "))
    }
    if ($found.Count -gt 1) {
        throw "More than one volume matches the SSD identity ($Model / $Serial). Refusing to guess."
    }
    return $found[0]
}

function Resolve-BackupVolume {
    param([string]$Serial, [string]$Model, [string]$Label)
    $selected = Select-BackupVolume -Volumes (Get-BackupVolumeCandidates) -Serial $Serial -Model $Model -Label $Label
    $script:VolumeInfo = $selected
    return $selected
}

function Assert-SafeTarget {
    param([string]$TargetPath, [string[]]$Sources)

    if ([string]::IsNullOrWhiteSpace($TargetPath)) {
        throw 'Target is empty. Pass -Target <folder>.'
    }

    $full = [System.IO.Path]::GetFullPath($TargetPath)
    if ($full -match '^[A-Za-z]:\\' -and $full.Substring(0, 1) -ieq 'C') {
        throw "Refusing target on C:. Backups must not live on the drive being wiped. Target: $full"
    }
    if ($full -match '^([A-Za-z]):\\') {
        $targetLetter = $Matches[1]
        try {
            $targetPartition = Get-Partition -DriveLetter $targetLetter -ErrorAction SilentlyContinue | Select-Object -First 1
            $systemPartition = Get-Partition -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -ne $targetPartition -and $null -ne $systemPartition -and
                [int]$targetPartition.DiskNumber -eq [int]$systemPartition.DiskNumber) {
                throw "Refusing target on the same physical disk as C:. Target: $full"
            }
        }
        catch {
            if ($_.Exception.Message -like 'Refusing target on the same physical disk*') { throw }
        }
    }

    if ($null -ne $script:VolumeInfo) {
        $allowed = ($script:VolumeInfo.Root.TrimEnd('\') + '\' + $BackupFolderName)
        $allowed = [System.IO.Path]::GetFullPath($allowed).TrimEnd('\')
        if (-not $full.TrimEnd('\').Equals($allowed, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw ("Refusing to write outside the one approved folder on the SSD.`n  allowed: $allowed`n  target:  $full")
        }
    }

    foreach ($source in $Sources) {
        if ([string]::IsNullOrWhiteSpace($source)) { continue }
        if (-not (Test-Path -LiteralPath $source)) { continue }
        if ((Test-IsUnderPath -Child $full -Parent $source) -or (Test-IsUnderPath -Child $source -Parent $full)) {
            throw "Target and source overlap. Target: $full Source: $source"
        }
    }
}

function Resolve-Confirmation {
    param([string]$Supplied, [switch]$Quiet)

    if ($Supplied -eq $script:ConfirmPhrase) { return }

    if (-not [string]::IsNullOrEmpty($Supplied)) {
        throw "Wrong confirmation. Expected exactly: $($script:ConfirmPhrase)"
    }

    if ($Quiet) {
        throw "Apply needs -ConfirmText $($script:ConfirmPhrase) when no prompt is allowed."
    }

    Write-Host ''
    Write-Host 'This will copy your data to the SSD, leave regenerable folders behind, and change files in the backup folder only.' -ForegroundColor Red
    Write-Host "Type $($script:ConfirmPhrase) to continue (anything else aborts):"
    $typed = Read-Host
    if ($typed -ne $script:ConfirmPhrase) {
        throw 'Confirmation did not match. Nothing was changed.'
    }
}

function Resolve-RepoRoot {
    if (-not [string]::IsNullOrWhiteSpace($script:RepoRoot)) {
        return [System.IO.Path]::GetFullPath($script:RepoRoot)
    }
    $here = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($here)) {
        $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Split-Path -Parent (Split-Path -Parent $here))
}

function Test-TreeHashes {
    param(
        [string]$Source,
        [string]$Destination,
        [switch]$Quiet,
        [switch]$AllowUnstable
    )

    $sourceFiles = Get-TreeFiles -Root $Source
    $destFiles = Get-TreeFiles -Root $Destination
    if (-not $AllowUnstable -and $sourceFiles.Count -ne $destFiles.Count) {
        throw "File count mismatch. Source $($sourceFiles.Count), destination $($destFiles.Count)."
    }

    $sourceRoot = (ConvertTo-LongPath (Resolve-Path -LiteralPath $Source).Path).TrimEnd('\')
    $destRoot = (ConvertTo-LongPath (Resolve-Path -LiteralPath $Destination).Path).TrimEnd('\')
    $manifest = New-Object System.Collections.Generic.List[object]
    $checked = 0

    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
        $destPath = $destRoot + '\' + $relative
        $destFull = $destPath
        if ($destFull.StartsWith('\\?\')) { $destFull = $destFull.Substring(4) }

        $sourceHash = $null
        $destHash = $null
        try {
            if ([System.IO.File]::Exists((ConvertTo-LongPath $destPath))) {
                $destItem = [System.IO.FileInfo]::new((ConvertTo-LongPath $destPath))
                if ($destItem.Length -eq $file.Length) {
                    $sourceHash = Get-Sha256 -Path $file.FullName
                    $destHash = Get-Sha256 -Path $destPath
                }
            }
        }
        catch {
            $sourceHash = $null
            $destHash = $null
        }

        if ($null -ne $sourceHash -and $sourceHash -eq $destHash) {
            $manifest.Add([pscustomobject]@{
                RelativePath = $relative
                Bytes        = [long]$file.Length
                Sha256       = $sourceHash
            })
            $checked++
            if (-not $Quiet -and ($checked % 500) -eq 0) {
                Write-Host "    verified $checked files..."
            }
            continue
        }

        if (-not $AllowUnstable) {
            foreach ($suffix in @('', '-wal', '-shm')) {
                if ((Split-Path -Leaf $relative) -eq ('state.sqlite' + $suffix)) {
                    throw "Live database file was copied: $relative. The snapshot step must exclude it."
                }
            }
            if (-not [System.IO.File]::Exists((ConvertTo-LongPath $destPath))) {
                throw "Missing copy: $relative"
            }
            throw "SHA256 mismatch: $relative"
        }

        # A live tree changes while it is copied (logs, settings). Re-copy this
        # one file once and compare again, then record it as unstable instead of
        # failing the whole run.
        [System.IO.File]::Copy($file.FullName, (ConvertTo-LongPath $destPath), $true)
        try {
            $sourceHash = Get-Sha256 -Path $file.FullName
            $destHash = Get-Sha256 -Path $destPath
        }
        catch {
            $script:Unstable.Add($relative)
            continue
        }
        if ($sourceHash -eq $destHash) {
            $manifest.Add([pscustomobject]@{
                RelativePath = $relative
                Bytes        = [long]$file.Length
                Sha256       = $sourceHash
            })
            continue
        }
        $script:Unstable.Add($relative)
    }

    return $manifest
}

function Copy-TreeAndVerify {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ManifestPath = '',
        [string[]]$ExcludeFiles = @(),
        [switch]$AllowUnstable
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Source folder does not exist: $Source"
    }

    Write-Host "    copying $Source -> $Destination"
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
    if ($null -ne $robocopy) {
        $robocopyArgs = @(
            $Source,
            $Destination,
            '/E',
            '/COPY:DAT',
            '/DCOPY:DAT',
            '/R:2',
            '/W:5',
            '/XJ',
            '/NFL',
            '/NDL',
            '/NP',
            '/NJH',
            '/NJS',
            '/XD'
        )
        $robocopyArgs += $script:ExcludeDirNames
        if ($script:ExcludeDirs.Count -gt 0) { $robocopyArgs += $script:ExcludeDirs }
        if ($ExcludeFiles.Count -gt 0) {
            $robocopyArgs += '/XF'
            $robocopyArgs += $ExcludeFiles
        }
        & $robocopy.Source @robocopyArgs | Out-Null
        $code = $LASTEXITCODE
        if ($code -ge 8) {
            throw "robocopy failed with exit code $code for $Source"
        }
    }
    else {
        Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
    }

    $manifest = Test-TreeHashes -Source $Source -Destination $Destination -AllowUnstable:$AllowUnstable

    if ($script:Unstable.Count -gt 25) {
        throw "Too many files changed while copying ($($script:Unstable.Count)). The target or the source is unstable; stop and investigate."
    }
    foreach ($relative in $script:Unstable) {
        $candidate = Join-Path $Source $relative
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and ((Get-Item -LiteralPath $candidate -Force).Length -gt 50MB)) {
            throw "A large file kept changing while copying: $relative. Stop hbots with -StopServer and rerun."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
        $dir = Split-Path -Parent $ManifestPath
        if (-not [string]::IsNullOrWhiteSpace($dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $manifest | Export-Csv -LiteralPath $ManifestPath -NoTypeInformation -Encoding ASCII
        Write-Host "    hash manifest: $ManifestPath ($($manifest.Count) files)"
    }

    return $manifest
}

function Invoke-StopServer {
    param([string]$Root)

    $stopScript = Join-Path $Root 'scripts\personal\stop.ps1'
    if (-not (Test-Path -LiteralPath $stopScript)) {
        throw "stop.ps1 not found at $stopScript"
    }

    Write-Host "    stopping hbots with $stopScript"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
    if ($LASTEXITCODE -ne 0) {
        throw "stop.ps1 exited $LASTEXITCODE"
    }

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $listener = Get-NetTCPConnection -LocalPort 38472 -State Listen -ErrorAction SilentlyContinue
        if ($null -eq $listener) {
            Write-Host '    hbots is stopped (port 38472 closed)'
            return
        }
        Start-Sleep -Seconds 2
    }
    throw 'hbots port 38472 is still listening 60 seconds after stop.ps1.'
}

function Resolve-NodeExe {
    foreach ($name in @('node.exe', 'node')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }
    return $null
}

function Invoke-DatabaseSnapshot {
    param(
        [string]$DataRoot,
        [string]$DestinationRoot,
        [string]$RepoRoot,
        [string]$NodeExe
    )

    $source = Join-Path (Join-Path $DataRoot 'dev\userdata') 'state.sqlite'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "No database at $source. The data root layout is not what prewipe expects."
    }
    $helper = Join-Path $RepoRoot 'scripts\personal\sqlite-snapshot.cjs'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw "Snapshot helper missing: $helper"
    }
    if ([string]::IsNullOrWhiteSpace($NodeExe)) {
        throw 'node.exe was not found. Node 24 is needed for the live SQLite snapshot.'
    }

    $destDir = Join-Path $DestinationRoot 'dev\userdata'
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    $target = Join-Path $destDir 'state.sqlite'
    $proof = "$target.integrity.json"
    foreach ($stale in @($target, "$target-wal", "$target-shm", $proof)) {
        if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
    }

    $sourceBytes = (Get-Item -LiteralPath $source -Force).Length
    Write-Host ("    SQLite online backup of {0} ({1})" -f $source, (Format-Bytes $sourceBytes))
    $started = Get-Date
    $env:PB_SNAPSHOT_SOURCE = $source
    $env:PB_SNAPSHOT_TARGET = $target
    try {
        & $NodeExe '--disable-warning=ExperimentalWarning' $helper
        $code = $LASTEXITCODE
    }
    finally {
        Remove-Item Env:PB_SNAPSHOT_SOURCE -ErrorAction SilentlyContinue
        Remove-Item Env:PB_SNAPSHOT_TARGET -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) {
        throw "SQLite online snapshot failed (exit $code). Nothing was left in place."
    }
    if (-not (Test-Path -LiteralPath $proof -PathType Leaf)) {
        throw "Snapshot integrity proof is missing: $proof"
    }
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $bytes = (Get-Item -LiteralPath $target -Force).Length
    $script:Timings.databaseSeconds = $seconds
    $script:Timings.databaseBytes = $bytes
    Write-Host ("    database snapshot verified: {0}, {1:N1} s" -f (Format-Bytes $bytes), $seconds)
    return [pscustomobject]@{ Path = $target; Proof = $proof; Bytes = $bytes; Seconds = $seconds }
}

function Invoke-SecretsExport {
    param(
        [string]$DataRoot,
        [string]$ReleaseName,
        [string]$BundlePath,
        [string]$NodeExe
    )

    if ([string]::IsNullOrWhiteSpace($NodeExe)) {
        throw 'node.exe was not found. Node 24 is needed for the secrets export.'
    }
    $bin = Join-Path (Join-Path (Join-Path $DataRoot 'releases') $ReleaseName) 'dist\bin.mjs'
    if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) {
        throw "The release CLI is missing: $bin"
    }
    $secretsDir = Join-Path (Join-Path $DataRoot 'dev\userdata') 'secrets'
    if (-not (Test-Path -LiteralPath $secretsDir -PathType Container)) {
        throw "No secrets folder at $secretsDir. Nothing was exported."
    }

    Write-Host ''
    Write-Host '    Choose the passphrase that seals the secrets bundle.' -ForegroundColor Yellow
    Write-Host '    Type the same passphrase later on the new Omarchy machine when it asks.'
    Write-Host '    It is not shown, not written to a file and not put on the command line.'
    try {
        $first = Read-Host -AsSecureString '    passphrase (12+ characters)'
        $second = Read-Host -AsSecureString '    passphrase again'
    }
    catch {
        throw 'The passphrase prompt needs an interactive PowerShell window. Run prewipe.ps1 directly in a terminal.'
    }

    $handle1 = [IntPtr]::Zero
    $handle2 = [IntPtr]::Zero
    $code = 1
    $output = @()
    $entries = $null
    try {
        $handle1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
        $handle2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
        $plain1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle1)
        $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle2)
        if ($plain1 -cne $plain2) {
            throw 'The two passphrases differ. Nothing was exported; run again.'
        }
        if ($plain1.Length -lt 12) {
            throw 'The passphrase is shorter than 12 characters. Nothing was exported; run again.'
        }

        $arguments = @($bin, 'secrets', 'export', '--secrets-dir', $secretsDir, '--out', $BundlePath)
        if (Test-Path -LiteralPath $BundlePath) { $arguments += '--force' }
        $output = @($plain1 | & $NodeExe @arguments 2>&1)
        $code = $LASTEXITCODE
    }
    finally {
        if ($handle1 -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle1) }
        if ($handle2 -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle2) }
        $plain1 = $null
        $plain2 = $null
    }

    if ($code -ne 0) {
        $detail = (($output | Out-String).Trim() -replace '(?i)passphrase[^,;]*', 'passphrase <hidden>')
        throw "Secrets export failed (exit $code): $detail"
    }
    if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
        throw "Secrets export reported success but $BundlePath is missing."
    }
    foreach ($line in $output) {
        if ("$line" -match 'Exported\s+(\d+)\s+saved secret') { $entries = [int]$Matches[1] }
        elseif ("$line" -match 'entries.*?(\d+)') { if ($null -eq $entries) { $entries = [int]$Matches[1] } }
    }

    $bytes = (Get-Item -LiteralPath $BundlePath -Force).Length
    $sha = Get-Sha256 -Path $BundlePath
    Write-Host ("    sealed bundle: {0}, {1} saved secret(s), sha256 {2}" -f (Format-Bytes $bytes), $entries, $sha.Substring(0, 16))
    Write-Host '    the passphrase is the only way to open it; keep it in your head, not on the SSD'
    return [pscustomobject]@{ Path = $BundlePath; Bytes = $bytes; Sha256 = $sha; Entries = $entries }
}

function ConvertTo-LfText {
    param([string]$Path)
    $text = [System.IO.File]::ReadAllText($Path)
    $text = $text -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Payload {
    param(
        [string]$TargetPath,
        [string]$RepoRoot,
        [string]$SecretsBundle
    )

    $payload = Join-Path $TargetPath 'payload'
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    $linuxDir = Join-Path $RepoRoot 'migrate\linux'
    $files = @('first-login.sh', 'bootstrap.sh', 'verify.sh', 'enable-ssh.sh', 'PASTE.txt')

    $manifestLines = New-Object System.Collections.Generic.List[string]
    foreach ($name in $files) {
        $src = Join-Path $linuxDir $name
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
            throw "payload source missing: $src (merge the Linux branch first)"
        }
        $dst = Join-Path $payload $name
        Copy-Item -LiteralPath $src -Destination $dst -Force
        ConvertTo-LfText -Path $dst
        $hash = Get-Sha256 -Path $dst
        $manifestLines.Add("$hash  payload/$name")
        $copyCheck = Get-Sha256 -Path $dst
        if ($copyCheck -ne $hash) { throw "payload copy changed bytes: $name" }
    }

    $hasBundle = $false
    if (-not [string]::IsNullOrWhiteSpace($SecretsBundle) -and (Test-Path -LiteralPath $SecretsBundle -PathType Leaf)) {
        $bundleTarget = Join-Path $TargetPath 'secrets.bundle'
        $sameFile = [System.IO.Path]::GetFullPath($SecretsBundle).Equals([System.IO.Path]::GetFullPath($bundleTarget), [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $sameFile) {
            Copy-Item -LiteralPath $SecretsBundle -Destination $bundleTarget -Force
        }
        $bundleHash = Get-Sha256 -Path $bundleTarget
        $manifestLines.Add("$bundleHash  secrets.bundle")
        $hasBundle = $true
        Write-Host "    secrets bundle copied ($(Format-Bytes (Get-Item -LiteralPath $bundleTarget -Force).Length)); contents not read"
    }

    $manifestPath = Join-Path $TargetPath 'payload.sha256'
    [System.IO.File]::WriteAllText($manifestPath, (($manifestLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

    $paste = [System.IO.File]::ReadAllText((Join-Path $linuxDir 'PASTE.txt')).Trim()
    $pasteText = @(
        'HBOTS OMARCHY - FIRST LOGIN',
        '',
        'The SanDisk is plugged in. On the new Omarchy desktop:',
        '  1. Press Super, open Terminal.',
        '  2. Paste this ONE line (copy it from this file), then press Enter:',
        '',
        $paste,
        '',
        'It mounts the SSD read-only, checks every file, restores your data, installs',
        'everything, starts hbots and runs the health check by itself. It asks once for',
        'your secrets passphrase (typing is hidden). Nothing else is needed.',
        '',
        'It prints SUCCESS or FAILED at the end. If it fails it leaves the SSD mounted',
        'and names the log file; do not reinstall, send us that log.',
        ''
    ) -join "`n"
    [System.IO.File]::WriteAllText((Join-Path $TargetPath 'PASTE-ME.txt'), $pasteText, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "    payload: $($files.Count) scripts, paste line, hashes$(if ($hasBundle) { ', secrets bundle' } else { ', NO secrets bundle' })"
    return [pscustomobject]@{ HasBundle = $hasBundle; Hashes = $manifestLines.Count }
}

function Write-CommandCapture {
    param(
        [string]$Path,
        [string]$FilePath,
        [string[]]$Arguments
    )
    try {
        $output = & $FilePath @Arguments 2>&1
        $text = ($output | Out-String).TrimEnd()
        Set-Content -LiteralPath $Path -Value $text -Encoding ASCII
    }
    catch {
        Set-Content -LiteralPath $Path -Value ("not available: " + $_.Exception.Message) -Encoding ASCII
    }
}

function Write-Inventory {
    param([string]$TargetPath, [string]$Root)

    $inventory = Join-Path $TargetPath 'inventory'
    New-Item -ItemType Directory -Path $inventory -Force | Out-Null
    Write-Host "    inventory -> $inventory"

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -ne $winget) {
        & $winget.Source list --disable-interactivity 2>&1 | Set-Content -LiteralPath (Join-Path $inventory 'winget-list.txt') -Encoding ASCII
    }
    else {
        Set-Content -LiteralPath (Join-Path $inventory 'winget-list.txt') -Value 'winget not installed' -Encoding ASCII
    }

    $versions = New-Object System.Collections.Generic.List[string]
    foreach ($tool in @('node', 'npm', 'pnpm', 'git', 'python', 'python3', 'powershell', 'code', 'gh')) {
        $command = Get-Command $tool -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            $versions.Add("$tool`: not found")
            continue
        }
        try {
            $version = (& $command.Source --version 2>&1 | Select-Object -First 1)
            $versions.Add("$tool`: $version ($($command.Source))")
        }
        catch {
            $versions.Add("$tool`: found at $($command.Source), version failed")
        }
    }
    Set-Content -LiteralPath (Join-Path $inventory 'tool-versions.txt') -Value $versions -Encoding ASCII

    try {
        Get-ScheduledTask -ErrorAction Stop |
            Select-Object TaskPath, TaskName, State |
            Sort-Object TaskPath, TaskName |
            Export-Csv -LiteralPath (Join-Path $inventory 'scheduled-tasks.csv') -NoTypeInformation -Encoding ASCII
    }
    catch {
        Set-Content -LiteralPath (Join-Path $inventory 'scheduled-tasks.csv') -Value ("failed: " + $_.Exception.Message) -Encoding ASCII
    }

    try {
        $rules = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop
        $rows = foreach ($rule in $rules) {
            $ports = ''
            try {
                $filter = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
                $ports = (@($filter.LocalPort) -join ',')
            }
            catch { $ports = '' }
            [pscustomobject]@{
                DisplayName = $rule.DisplayName
                Profile     = [string]$rule.Profile
                Protocol    = [string]$rule.Protocol
                LocalPort   = $ports
            }
        }
        $rows | Sort-Object DisplayName | Export-Csv -LiteralPath (Join-Path $inventory 'firewall-inbound-allow.csv') -NoTypeInformation -Encoding ASCII
    }
    catch {
        Set-Content -LiteralPath (Join-Path $inventory 'firewall-inbound-allow.csv') -Value ("failed: " + $_.Exception.Message) -Encoding ASCII
    }

    try {
        Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Select-Object LocalAddress, LocalPort, OwningProcess |
            Sort-Object LocalPort |
            Export-Csv -LiteralPath (Join-Path $inventory 'listening-ports.csv') -NoTypeInformation -Encoding ASCII
    }
    catch {
        Set-Content -LiteralPath (Join-Path $inventory 'listening-ports.csv') -Value ("failed: " + $_.Exception.Message) -Encoding ASCII
    }

    $braveRoot = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data'
    $braveRows = New-Object System.Collections.Generic.List[object]
    if (Test-Path -LiteralPath $braveRoot) {
        foreach ($profile in (Get-ChildItem -LiteralPath $braveRoot -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($profile.Name -ne 'Default' -and $profile.Name -notlike 'Profile *' -and $profile.Name -ne 'Guest Profile') { continue }
            $bookmarks = Join-Path $profile.FullName 'Bookmarks'
            $braveRows.Add([pscustomobject]@{
                Profile        = $profile.Name
                LastWrite      = $profile.LastWriteTime.ToString('o')
                BookmarksBytes = if (Test-Path -LiteralPath $bookmarks) { (Get-Item -LiteralPath $bookmarks -Force).Length } else { 0 }
            })
        }
    }
    $braveRows | Export-Csv -LiteralPath (Join-Path $inventory 'brave-profiles.csv') -NoTypeInformation -Encoding ASCII

    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $cs = Get-CimInstance Win32_ComputerSystem
        $volumes = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
            Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace
        $system = [pscustomobject]@{
            ComputerName = $env:COMPUTERNAME
            CapturedAt   = (Get-Date).ToString('o')
            OS           = $os.Caption
            Version      = $os.Version
            Build        = $os.BuildNumber
            Manufacturer = $cs.Manufacturer
            Model        = $cs.Model
            TotalRAMGB   = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
            Volumes      = $volumes
        }
        $system | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $inventory 'system-info.json') -Encoding ASCII
    }
    catch {
        Set-Content -LiteralPath (Join-Path $inventory 'system-info.json') -Value ("failed: " + $_.Exception.Message) -Encoding ASCII
    }

    if ($null -ne $script:VolumeInfo) {
        $backupVolume = [ordered]@{
            drive         = $script:VolumeInfo.DriveLetter
            label         = $script:VolumeInfo.FileSystemLabel
            fileSystem    = $script:VolumeInfo.FileSystem
            model         = $script:VolumeInfo.Disk.FriendlyName
            serial        = ([string]$script:VolumeInfo.Disk.SerialNumber).Trim()
            busType       = $script:VolumeInfo.Disk.BusType
            sizeGB        = [math]::Round($script:VolumeInfo.Size / 1GB, 1)
            freeGB        = [math]::Round($script:VolumeInfo.SizeRemaining / 1GB, 1)
            target        = $Target
            approvedFolder = $BackupFolderName
        }
        $backupVolume | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $inventory 'backup-volume.json') -Encoding ASCII
    }

    Write-CommandCapture -Path (Join-Path $inventory 'ipconfig.txt') -FilePath 'ipconfig.exe' -Arguments @('/all')
    Write-CommandCapture -Path (Join-Path $inventory 'route-print.txt') -FilePath 'route.exe' -Arguments @('print')
}

function Get-SourcePlan {
    param([string]$Fixture, [string]$Claude, [string]$Data)

    if ($Scope -eq 'Small') {
        if ([string]::IsNullOrWhiteSpace($Fixture)) {
            throw '-Scope Small needs -FixtureRoot <folder>. It never touches a real profile.'
        }
        $fixtureFull = [System.IO.Path]::GetFullPath($Fixture)
        if (-not (Test-Path -LiteralPath $fixtureFull -PathType Container)) {
            throw "Fixture root does not exist: $fixtureFull"
        }
        $claudeFixture = Join-Path $fixtureFull 'Claude'
        $dataFixture = Join-Path $fixtureFull 'personal-bots'
        if (-not (Test-Path -LiteralPath $claudeFixture)) {
            $claudeFixture = Join-Path $fixtureFull 'fixture'
        }
        if (-not (Test-Path -LiteralPath $dataFixture)) {
            $dataFixture = Join-Path $fixtureFull 'fixture'
        }
        return @(
            [pscustomobject]@{ Name = 'Claude'; Source = $claudeFixture; DestinationName = 'Claude' },
            [pscustomobject]@{ Name = 'personal-bots'; Source = $dataFixture; DestinationName = 'personal-bots' }
        )
    }

    return @(
        [pscustomobject]@{ Name = 'Claude'; Source = $Claude; DestinationName = 'Claude'; Optional = $false },
        [pscustomobject]@{ Name = 'personal-bots'; Source = $Data; DestinationName = 'personal-bots'; Optional = $false },
        [pscustomobject]@{ Name = 'ssh'; Source = (Join-Path $env:USERPROFILE '.ssh'); DestinationName = 'ssh'; Optional = $true },
        [pscustomobject]@{ Name = 'cloudflared'; Source = (Join-Path $env:USERPROFILE '.cloudflared'); DestinationName = 'cloudflared'; Optional = $true }
    )
}

function Invoke-SelfTest {
    $root = Join-Path $env:TEMP ('prewipe-selftest-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $root 'source'
    $dest = Join-Path $root 'dest'
    $manifestPath = Join-Path $root 'manifest.csv'

    try {
        Write-Step 'prewipe self-test'
        New-Item -ItemType Directory -Path (Join-Path $source 'nested') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $source 'a.txt') -Value 'alpha' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $source 'nested\b.txt') -Value ('beta-' + ('x' * 100)) -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $source 'empty.txt') -Value '' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $source 'name with space.txt') -Value 'space' -Encoding ASCII
        $bytes = New-Object byte[] 65536
        (New-Object System.Random(42)).NextBytes($bytes)
        [System.IO.File]::WriteAllBytes((Join-Path $source 'nested\binary.bin'), $bytes)

        # Regenerable folders and old releases must be left behind; the live
        # release is kept.
        New-Item -ItemType Directory -Path (Join-Path $source 'node_modules') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $source 'node_modules\junk.bin') -Value 'junk' -Encoding ASCII
        New-Item -ItemType Directory -Path (Join-Path $source 'releases\old') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $source 'releases\live') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $source 'releases\current.txt') -Value 'live' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $source 'releases\old\junk.bin') -Value 'old' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $source 'releases\live\keep.txt') -Value 'keep' -Encoding ASCII
        $script:ExcludeDirs = @(Get-ReleaseExclusions -Source $source)

        $plan = Get-SourcePlan -Fixture $root -Claude 'C:\Claude' -Data (Join-Path $env:USERPROFILE '.personal-bots')
        if ($null -eq $plan) { throw 'source plan was empty' }

        $manifest = Copy-TreeAndVerify -Source $source -Destination $dest -ManifestPath $manifestPath
        if ($manifest.Count -ne 7) { throw "expected 7 files (exclusions applied), got $($manifest.Count)" }
        if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'manifest was not written' }
        Write-Host 'PASS copy and SHA256 verification'

        if (Test-Path -LiteralPath (Join-Path $dest 'node_modules')) { throw 'node_modules was copied' }
        if (Test-Path -LiteralPath (Join-Path $dest 'releases\old')) { throw 'an old release was copied' }
        if (-not (Test-Path -LiteralPath (Join-Path $dest 'releases\live\keep.txt'))) { throw 'the live release was not copied' }
        Write-Host 'PASS regenerable folders and old releases are left behind'

        $bad = Test-TreeHashes -Source $source -Destination $dest -Quiet
        if ($bad.Count -ne 7) { throw 'second verification changed the file count' }
        Write-Host 'PASS repeat verification is stable'

        Add-Content -LiteralPath (Join-Path $dest 'a.txt') -Value 'tampered'
        $detected = $false
        try {
            Test-TreeHashes -Source $source -Destination $dest -Quiet | Out-Null
        }
        catch {
            $detected = $true
        }
        if (-not $detected) { throw 'tampering was not detected' }
        Write-Host 'PASS tampered copy is rejected'

        $rejected = $false
        try { Assert-SafeTarget -TargetPath 'C:\temp\prewipe-target' -Sources @($source) }
        catch { $rejected = $true }
        if (-not $rejected) { throw 'C: target was not refused' }
        Write-Host 'PASS target on C: is refused'

        $rejected = $false
        try { Assert-SafeTarget -TargetPath (Join-Path $source 'inside') -Sources @($source) }
        catch { $rejected = $true }
        if (-not $rejected) { throw 'overlapping target was not refused' }
        Write-Host 'PASS target inside source is refused'

        # The SSD is identified by model, serial, label, NTFS and USB - never by
        # drive letter - and writing outside the one approved folder is refused.
        $goodVolume = [pscustomobject]@{
            DriveLetter = 'F'; Root = 'F:\'; FileSystemLabel = 'New Volume'; FileSystem = 'NTFS'
            Size = 1000GB; SizeRemaining = 700GB
            Disk = [pscustomobject]@{ FriendlyName = 'SanDisk Extreme 55AE'; SerialNumber = '2306CQ402457  '; BusType = 'USB' }
        }
        $wrongSerial = [pscustomobject]@{
            DriveLetter = 'G'; Root = 'G:\'; FileSystemLabel = 'New Volume'; FileSystem = 'NTFS'
            Size = 1000GB; SizeRemaining = 700GB
            Disk = [pscustomobject]@{ FriendlyName = 'SanDisk Extreme 55AE'; SerialNumber = '9999XX999999'; BusType = 'USB' }
        }
        $notUsb = [pscustomobject]@{
            DriveLetter = 'H'; Root = 'H:\'; FileSystemLabel = 'New Volume'; FileSystem = 'NTFS'
            Size = 1000GB; SizeRemaining = 700GB
            Disk = [pscustomobject]@{ FriendlyName = 'SanDisk Extreme 55AE'; SerialNumber = '2306CQ402457'; BusType = 'SATA' }
        }
        $picked = Select-BackupVolume -Volumes @($goodVolume) -Serial '2306CQ402457' -Model 'SanDisk Extreme 55AE' -Label 'New Volume'
        if ($picked.DriveLetter -ne 'F') { throw 'the matching SSD was not selected' }
        foreach ($case in @(@{ Name = 'wrong serial'; Volume = $wrongSerial }, @{ Name = 'non-USB bus'; Volume = $notUsb })) {
            $refused = $false
            try { Select-BackupVolume -Volumes @($case.Volume) -Serial '2306CQ402457' -Model 'SanDisk Extreme 55AE' -Label 'New Volume' | Out-Null }
            catch { $refused = $true }
            if (-not $refused) { throw "an SSD with a $($case.Name) was accepted" }
        }
        $duplicate = [pscustomobject]@{
            DriveLetter = 'G'; Root = 'G:\'; FileSystemLabel = 'New Volume'; FileSystem = 'NTFS'
            Size = 1000GB; SizeRemaining = 700GB
            Disk = [pscustomobject]@{ FriendlyName = 'SanDisk Extreme 55AE'; SerialNumber = '2306CQ402457'; BusType = 'USB' }
        }
        $refused = $false
        try { Select-BackupVolume -Volumes @($goodVolume, $duplicate) -Serial '2306CQ402457' -Model 'SanDisk Extreme 55AE' -Label 'New Volume' | Out-Null }
        catch { $refused = $true }
        if (-not $refused) { throw 'two matching SSDs were accepted instead of refused' }
        Write-Host 'PASS SSD identity is matched by model, serial, label, NTFS and USB'

        $script:VolumeInfo = $goodVolume
        $refused = $false
        try { Assert-SafeTarget -TargetPath 'F:\somewhere-else' -Sources @($source) }
        catch { $refused = $true }
        if (-not $refused) { throw 'writing outside the approved SSD folder was accepted' }
        Write-Host 'PASS a folder outside the approved SSD folder is refused'
        Assert-SafeTarget -TargetPath 'F:\hbots-omarchy-backup' -Sources @($source)
        Write-Host 'PASS the approved SSD folder is accepted'
        $script:VolumeInfo = $null

        $payloadRoot = Join-Path $root 'payload-target'
        New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
        $payload = Write-Payload -TargetPath $payloadRoot -RepoRoot (Resolve-RepoRoot) -SecretsBundle ''
        if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot 'payload\first-login.sh'))) { throw 'first-login.sh was not written to the payload' }
        if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot 'PASTE-ME.txt'))) { throw 'PASTE-ME.txt was not written' }
        if ($payload.HasBundle) { throw 'a bundle was reported when none was passed' }
        $hashLines = @(Get-Content -LiteralPath (Join-Path $payloadRoot 'payload.sha256') | Where-Object { $_ -match '\S' })
        if ($hashLines.Count -lt 5) { throw "payload.sha256 has $($hashLines.Count) entries, expected at least 5" }
        $pasteLine = @(Get-Content -LiteralPath (Join-Path $payloadRoot 'PASTE-ME.txt') | Where-Object { $_ -like 'sudo bash -*' })
        if ($pasteLine.Count -ne 1) { throw "PASTE-ME.txt has $($pasteLine.Count) paste lines, expected exactly 1" }
        Write-Host 'PASS payload, paste line and hash manifest are written'

        $rejected = $false
        try { Resolve-Confirmation -Supplied 'wrong' -Quiet }
        catch { $rejected = $true }
        if (-not $rejected) { throw 'wrong confirmation was accepted' }
        Write-Host 'PASS wrong confirmation is refused'

        Resolve-Confirmation -Supplied $script:ConfirmPhrase -Quiet
        Write-Host 'PASS exact confirmation is accepted'

        $free = Get-FreeSpaceBytes -Path $env:TEMP
        if ($null -eq $free -or $free -le 0) { throw 'free-space check failed' }
        Write-Host ('PASS free-space check ({0})' -f (Format-Bytes $free))

        Write-Host 'SELFTEST PASS' -ForegroundColor Green
        return 0
    }
    catch {
        Write-Host ('SELFTEST FAIL: ' + $_.Exception.Message) -ForegroundColor Red
        if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
            Write-Host $_.ScriptStackTrace
        }
        return 1
    }
    finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($SelfTest) {
    if ($Apply) {
        Write-Host 'ERROR: -SelfTest and -Apply cannot be combined.' -ForegroundColor Red
        exit 2
    }
    exit (Invoke-SelfTest)
}

try {
    $script:RepoRoot = Resolve-RepoRoot
    if ($Apply -and $Practice) {
        throw 'choose -Apply or -Practice, not both.'
    }
    if ($Scope -eq 'Small') { $AllowAnyTarget = $true }

    # ---------------------------------------------------------------- target

    if ($Scope -eq 'Full' -and -not $AllowAnyTarget) {
        $volume = Resolve-BackupVolume -Serial $VolumeSerial -Model $VolumeModel -Label $VolumeLabel
        $expected = [System.IO.Path]::GetFullPath(($volume.Root.TrimEnd('\') + '\' + $BackupFolderName))
        if ([string]::IsNullOrWhiteSpace($Target)) {
            $Target = $expected
        }
        elseif (-not [System.IO.Path]::GetFullPath($Target).TrimEnd('\').Equals([System.IO.Path]::GetFullPath($expected).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing -Target '$Target'. The only approved destination on this SSD is '$expected'."
        }
        Write-Step 'Backup destination'
        Write-Host ("    drive:       {0}: ({1})" -f $volume.DriveLetter, $volume.FileSystemLabel)
        Write-Host ("    disk:        {0}, serial {1}, {2}" -f $volume.Disk.FriendlyName, ([string]$volume.Disk.SerialNumber).Trim(), $volume.Disk.BusType)
        Write-Host ("    free:        {0} of {1}" -f (Format-Bytes $volume.SizeRemaining), (Format-Bytes $volume.Size))
        Write-Host "    folder:      $Target"
        Write-Host '    writes stay inside this folder; nothing else on the drive is touched'
    }
    if ([string]::IsNullOrWhiteSpace($Target)) {
        throw 'Target is empty. Pass -Target <folder> (tests only) or plug in the SSD.'
    }

    # ---------------------------------------------------------------- sources

    $sources = Get-SourcePlan -Fixture $FixtureRoot -Claude $SourceClaude -Data $SourceData
    foreach ($item in $sources) {
        if (-not (Test-Path -LiteralPath $item.Source -PathType Container)) {
            if ($item.Optional) { continue }
            throw "Source folder does not exist: $($item.Source)"
        }
    }
    $sources = @($sources | Where-Object { Test-Path -LiteralPath $_.Source -PathType Container })

    Assert-SafeTarget -TargetPath $Target -Sources @($sources | ForEach-Object { $_.Source })

    $nodeExe = Resolve-NodeExe
    $snapshotHelper = Join-Path $script:RepoRoot 'scripts\personal\sqlite-snapshot.cjs'
    if (-not $SkipDatabase) {
        if ($null -eq $nodeExe) {
            throw 'node.exe was not found. Node 24 (node:sqlite) is needed for the live database snapshot.'
        }
        if (-not (Test-Path -LiteralPath $snapshotHelper -PathType Leaf)) {
            throw "Snapshot helper missing: $snapshotHelper"
        }
    }

    # The Windows release that is live now is only used for the secrets export.
    # The Linux server never runs it: bootstrap builds its own release on Linux,
    # because node-pty and the other native modules differ per platform.
    $cliReleaseName = ''
    $cliReleaseBin = ''
    $releasesRoot = Join-Path $SourceData 'releases'
    if (Test-Path -LiteralPath $releasesRoot -PathType Container) {
        # The live release may predate the secrets CLI (1.66.92 does), so use the
        # newest release bundle that carries `secrets export`.
        foreach ($dir in @(Get-ChildItem -LiteralPath $releasesRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
            $candidate = Join-Path $dir.FullName 'dist\bin.mjs'
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            if (Select-String -LiteralPath $candidate -Pattern 'passphrase-sealed' -SimpleMatch -Quiet) {
                $cliReleaseName = $dir.Name
                $cliReleaseBin = $candidate
                break
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($cliReleaseName)) {
        throw "No release under $releasesRoot has the secrets export CLI (dist\bin.mjs with secrets). Stage a 1.66.93+ build before install night."
    }
    Write-Host "    secrets CLI: release $cliReleaseName"

    $bundlePath = if (-not [string]::IsNullOrWhiteSpace($SecretsBundle)) { $SecretsBundle } else { Join-Path $Target 'secrets.bundle' }
    $hasBundle = (-not [string]::IsNullOrWhiteSpace($SecretsBundle)) -and (Test-Path -LiteralPath $SecretsBundle -PathType Leaf)
    $willExport = (-not $SkipPayload) -and (-not $SkipSecretsExport) -and (-not $hasBundle) -and ($Scope -eq 'Full') -and ($StopServer -or $Apply)
    if (-not $SkipPayload -and -not $hasBundle -and -not $willExport -and $Scope -eq 'Full') {
        if ($Apply) {
            throw "The sealed secrets bundle is missing: $bundlePath. Export it before install night (or pass -SkipPayload if that is deliberate)."
        }
        if ($Practice) {
            Write-Host "    WARNING: no secrets bundle at $bundlePath. A practice copy has no keys; install night exports them." -ForegroundColor Yellow
        }
        else {
            Write-Host '    secrets:     none yet; install night exports the bundle and asks for your passphrase'
        }
    }

    # ---------------------------------------------------------------- plan

    Write-Step 'Plan'
    $mode = 'DRY RUN (default)'
    if ($Apply) { $mode = 'APPLY (install night)' }
    if ($Practice) { $mode = 'PRACTICE (real copy, keeps hbots running, no phrase)' }
    Write-Host "    mode:        $mode"
    Write-Host "    scope:       $Scope"
    Write-Host "    target:      $Target"
    Write-Host "    repo:        $script:RepoRoot"
    Write-Host '    hbots build: built on Linux at first login from the restored checkout (native modules differ per platform)'
    foreach ($item in $sources) {
        Write-Host ("    source:      {0}" -f $item.Source)
    }
    if ($SkipDatabase) {
        Write-Host '    database:    kept from the previous run (--skip-database)' -ForegroundColor Yellow
    }
    else {
        Write-Host "    database:    live SQLite online backup (node:sqlite + full integrity check)"
    }
    if ($SkipPayload) {
        Write-Host '    payload:     not written (--skip-payload)'
    }
    else {
        $bundleNote = if ($hasBundle) {
            ', sealed secrets bundle'
        }
        elseif ($willExport) {
            ', sealed secrets bundle exported now (asks for your passphrase)'
        }
        else {
            ', NO secrets bundle'
        }
        Write-Host ("    payload:     scripts, one-paste line, hashes{0}" -f $bundleNote)
    }
    if (-not [string]::IsNullOrWhiteSpace($script:VolumeInfo.DriveLetter)) {
        Write-Host "    second copy: no (Harout: the SSD folder is the only copy)"
    }

    # ---------------------------------------------------------------- space

    Write-Step 'Free-space check'
    $targetFree = Get-FreeSpaceBytes -Path $Target
    # Walking all of C:\Claude takes minutes on this laptop. When the drive is
    # this empty the answer cannot change, so skip the walk (install night must
    # not spend 10 minutes measuring).
    $ample = [long]150GB
    if ($null -ne $targetFree -and $targetFree -ge $ample) {
        Write-Host ("    target free space: {0} (ample; size estimate skipped)" -f (Format-Bytes $targetFree))
        Write-Host '    PASS free space'
    }
    else {
        $needed = [long]0
        foreach ($item in $sources) {
            $script:ExcludeDirs = @(Get-ReleaseExclusions -Source $item.Source)
            $needed += (Get-PathSizeBytes -Path $item.Source)
        }
        $script:ExcludeDirs = @()
        # The database is snapshotted separately, so it is in the estimate above.
        # 10% margin for file-system overhead and the manifests.
        $needed = [long]($needed * 1.10)
        Write-Host ("    estimated need (data + database + manifests + margin): {0}" -f (Format-Bytes $needed))
        if ($null -eq $targetFree) {
            Write-Host '    target free space: unknown; check the drive before -Apply' -ForegroundColor Yellow
        }
        else {
            Write-Host ("    target free space: {0}" -f (Format-Bytes $targetFree))
            if ($targetFree -lt $needed) {
                throw "Not enough free space on target. Need about $(Format-Bytes $needed), have $(Format-Bytes $targetFree)."
            }
            Write-Host '    PASS free space'
        }
    }

    Write-Step 'Data scope'
    Write-Host '    no disk image, data only (Harout, 25 Oct)'
    Write-Host ("    excluded regenerable folders: {0}" -f ($script:ExcludeDirNames -join ', '))
    foreach ($item in $sources) {
        $skipped = @(Get-ReleaseExclusions -Source $item.Source)
        foreach ($dir in $skipped) {
            Write-Host "    old release left behind: $dir"
        }
    }

    Write-Step 'Plain copies and SHA256 verification'
    foreach ($item in $sources) {
        $destination = Join-Path (Join-Path $Target 'plain') $item.DestinationName
        Write-Plan "robocopy `"$($item.Source)`" `"$destination`" /E /COPY:DAT /XJ"
        Write-Plan "SHA256 every source file against the copy, manifest $Target\inventory\hash-$($item.Name).csv"
    }

    Write-Step 'Inventory'
    Write-Plan "winget list, tool versions, scheduled tasks, firewall rules and ports, Brave profiles, system info, SSD identity -> $Target\inventory"

    if (-not $Apply -and -not $Practice) {
        Write-Step 'Dry run complete'
        Write-Host '    Nothing was stopped, copied or written.' -ForegroundColor Green
        Write-Host "    Practice now: add -Practice. Install night: add -Apply and type $($script:ConfirmPhrase)." -ForegroundColor Green
        exit 0
    }

    if ($Apply) {
        Resolve-Confirmation -Supplied $ConfirmText
    }

    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }

    if ($StopServer) {
        Write-Step 'Stopping hbots'
        Invoke-StopServer -Root $script:RepoRoot
    }

    # ---------------------------------------------------------------- secrets

    $secretsExport = $null
    if ($willExport) {
        Write-Step 'Sealed secrets for the new machine'
        $secretsExport = Invoke-SecretsExport -DataRoot $SourceData -ReleaseName $cliReleaseName -BundlePath $bundlePath -NodeExe $nodeExe
        $hasBundle = $true
    }
    elseif ($hasBundle) {
        Write-Step 'Sealed secrets for the new machine'
        Write-Host "    using the bundle you passed: $bundlePath (contents not read)"
    }

    # ---------------------------------------------------------------- copy

    Write-Step 'Plain copies'
    $plainRoot = Join-Path $Target 'plain'
    $copiedAlready = Test-Path -LiteralPath (Join-Path $Target 'inventory')
    if ($copiedAlready) {
        Write-Host '    an earlier copy exists; robocopy only updates what changed (this is the seed)'
    }
    $totals = @{ Bytes = [long]0; Files = 0 }
    $sourceSummaries = @()
    foreach ($item in $sources) {
        $copyStarted = Get-Date
        $destination = Join-Path $plainRoot $item.DestinationName
        $manifestPath = Join-Path (Join-Path $Target 'inventory') ("hash-" + $item.Name + ".csv")
        $script:ExcludeDirs = @(Get-ReleaseExclusions -Source $item.Source)
        $script:Unstable.Clear()
        $excludeFiles = @()
        if ($item.Name -eq 'personal-bots') {
            $excludeFiles = @('state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm')
        }
        $manifest = Copy-TreeAndVerify -Source $item.Source -Destination $destination -ManifestPath $manifestPath -ExcludeFiles $excludeFiles -AllowUnstable
        $bytes = [long]0
        foreach ($entry in $manifest) { $bytes += [long]$entry.Bytes }
        $seconds = [math]::Round(((Get-Date) - $copyStarted).TotalSeconds, 1)
        foreach ($unstable in $script:Unstable) {
            Write-Host "    changed while copying (listed, not failed): $unstable" -ForegroundColor Yellow
        }
        Write-Host ("    {0}: {1} files, {2}, {3:N1} s" -f $item.Name, $manifest.Count, (Format-Bytes $bytes), $seconds)
        $totals.Bytes += $bytes
        $totals.Files += $manifest.Count
        $sourceSummaries += [pscustomobject]@{ Name = $item.Name; Files = $manifest.Count; Bytes = $bytes; Seconds = $seconds }
    }

    # ---------------------------------------------------------------- database

    $database = $null
    if (-not $SkipDatabase) {
        Write-Step 'Live database snapshot'
        $database = Invoke-DatabaseSnapshot -DataRoot $SourceData -DestinationRoot (Join-Path $plainRoot 'personal-bots') -RepoRoot $script:RepoRoot -NodeExe $nodeExe
    }

    # ---------------------------------------------------------------- payload

    $payload = $null
    if (-not $SkipPayload) {
        Write-Step 'First-login payload'
        $payload = Write-Payload -TargetPath $Target -RepoRoot $script:RepoRoot -SecretsBundle $bundlePath
        if (-not $payload.HasBundle -and $Scope -eq 'Full' -and $Apply) {
            throw 'The payload has no secrets.bundle. Refusing to finish install night without it.'
        }
    }

    # ---------------------------------------------------------------- inventory

    Write-Step 'Inventory'
    Write-Inventory -TargetPath $Target -Root $script:RepoRoot
    $leftBehind = New-Object System.Collections.Generic.List[string]
    $leftBehind.Add('Left behind on purpose (regenerable): ' + ($script:ExcludeDirNames -join ', '))
    foreach ($item in $sources) {
        $leftBehind.Add("source: $($item.Source)")
        foreach ($dir in @(Get-ReleaseExclusions -Source $item.Source)) {
            $leftBehind.Add("  old release not copied: $dir")
        }
    }
    if ($script:Unstable.Count -gt 0) {
        $leftBehind.Add('Changed while being copied (re-copied once, then listed):')
        foreach ($relative in $script:Unstable) { $leftBehind.Add("  unstable: $relative") }
    }
    $leftBehind.Add('The live database was copied with SQLite''s online backup API; state.sqlite-wal/-shm are not part of the copy.')
    $leftBehind.Add('Provider sign-ins (Claude, Codex, OpenCode, Antigravity, GitHub) are re-approved after install; their token stores are not copied.')
    $leftBehind.Add('Browser profiles hbots owns live under .personal-bots data roots and are copied with them; Harout''s own Brave profile is not.')
    $leftBehind.Add('There is no second copy on the gaming PC (Harout, 25 Oct). This folder is the only backup.')
    $leftBehind.Add('Nothing outside this folder on the SSD was written, moved or deleted.')
    Set-Content -LiteralPath (Join-Path (Join-Path $Target 'inventory') 'left-behind.txt') -Value $leftBehind -Encoding ASCII

    # ---------------------------------------------------------------- summary

    $finished = Get-Date
    $totalSeconds = [math]::Round(($finished - $script:Started).TotalSeconds, 1)
    $summary = [ordered]@{
        schema        = 1
        mode          = $(if ($Apply) { 'apply' } elseif ($Practice) { 'practice' } else { 'dry-run' })
        startedAt     = $script:Started.ToString('o')
        finishedAt    = $finished.ToString('o')
        seconds       = $totalSeconds
        target        = $Target
        volume        = $null
        sources       = $sourceSummaries
        secrets       = $secretsExport
        database      = $database
        payload       = $payload
        unstable      = @($script:Unstable)
        totals        = @{ files = $totals.Files; bytes = $totals.Bytes }
    }
    if ($null -ne $script:VolumeInfo) {
        $summary.volume = [ordered]@{
            drive  = $script:VolumeInfo.DriveLetter
            label  = $script:VolumeInfo.FileSystemLabel
            model  = $script:VolumeInfo.Disk.FriendlyName
            serial = ([string]$script:VolumeInfo.Disk.SerialNumber).Trim()
            bus    = $script:VolumeInfo.Disk.BusType
        }
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path (Join-Path $Target 'inventory') 'run-summary.json') -Encoding ASCII

    Write-Step 'Done'
    Write-Host ("    {0} files, {1} in {2:N1} s" -f $totals.Files, (Format-Bytes $totals.Bytes), $totalSeconds) -ForegroundColor Green
    if ($null -ne $database) {
        Write-Host ("    database snapshot: {0} in {1:N1} s" -f (Format-Bytes $database.Bytes), $database.Seconds) -ForegroundColor Green
    }
    Write-Host "    Everything is under $Target (this folder only)" -ForegroundColor Green
    if ($Practice) {
        Write-Host '    This is the seed. Install night runs the same command with -Apply and only syncs changes.' -ForegroundColor Green
    }
    else {
        Write-Host '    First login: open hbots-omarchy-backup\PASTE-ME.txt and paste its one line.' -ForegroundColor Green
    }
    Write-Host '    Keep the SSD until Omarchy is verified and QA is done.' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
