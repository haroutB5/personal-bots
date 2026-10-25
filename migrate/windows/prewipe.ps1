<#
.SYNOPSIS
    Capture the laptop before Omarchy replaces Windows.

.DESCRIPTION
    Default is a DRY RUN: every command is printed, nothing is written.
    Real work needs BOTH -Apply and the typed confirmation WIPE-LAPTOP-CONFIRMED.

    What -Apply does, in order:
      1. Optionally stops hbots (scripts/personal/stop.ps1) when -StopServer is given.
      2. Optionally takes a full VSS disk image of C: with wbadmin when -FullImage is given.
      3. Plain copies of C:\Claude, C:\Users\Ht\.personal-bots, ~/.ssh and
         ~/.cloudflared into -Target\plain. Regenerable folders (node_modules,
         build output, caches, old releases, runtimes, workspace, backups) are
         left behind and listed in the inventory.
      4. SHA256 verification of every copied file, plus a manifest CSV.
      5. Inventory: winget list, node/git/python versions, scheduled tasks,
         firewall allow rules and listening ports, Brave profiles, system info,
         and the excluded/left-behind folders.

    The default is data-only (Harout, 25 Oct: only our data and what hbots
    needs). -FullImage opts back into the whole-C: wbadmin capture when that is
    explicitly wanted; it is not the default because it is hundreds of GB.

    -Scope Small copies and hashes only a fixture tree under -FixtureRoot. It is
    for tests; it never copies a real user profile or a whole disk.

    -SelfTest runs argument validation plus a copy/hash round trip in a temp
    folder and exits 0 or 1. It touches nothing outside %TEMP%.

    Secrets: this script never opens, parses, prints or logs .env files or the
    contents of secrets folders. They are copied as opaque bytes and hashed like
    every other file. Hash manifests contain file names and hashes only.

.PARAMETER Target
    Destination SMB or local path. Default \\GAMINGPC\Backups\omarchy-migration.
    The share must exist and be writable. The free-space check runs before
    anything is written.

.PARAMETER StopServer
    Stop hbots cleanly before copying its SQLite database. Without this the copy
    can catch the database mid-write. Only the documented stop.ps1 is used.

.PARAMETER FullImage
    Also take a VSS-consistent wbadmin image of C: before the plain copies.
    Default off (data-only). Requires Windows Server Backup and a target that is
    not C: or the disk holding C:.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1 -Apply -StopServer -FullImage
#>
[CmdletBinding()]
param(
    [ValidateSet('Full', 'Small')]
    [string]$Scope = 'Full',

    [string]$Target = '\\GAMINGPC\Backups\omarchy-migration',

    [string]$SourceClaude = 'C:\Claude',

    [string]$SourceData = (Join-Path $env:USERPROFILE '.personal-bots'),

    [string]$RepoRoot = '',

    [switch]$StopServer,

    [switch]$FullImage,

    [switch]$Apply,

    [string]$ConfirmText = '',

    [string]$FixtureRoot = '',

    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$script:ConfirmPhrase = 'WIPE-LAPTOP-CONFIRMED'
$script:RepoRoot = $RepoRoot

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
    param([string]$Source)
    # Keep only the live release from a personal-bots tree.
    $result = @()
    $releases = Join-Path $Source 'releases'
    $current = Join-Path $releases 'current.txt'
    if (-not (Test-Path -LiteralPath $current -PathType Leaf)) { return $result }
    $active = (Get-Content -LiteralPath $current -Raw).Trim()
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

function Assert-SafeTarget {
    param([string]$TargetPath, [string[]]$Sources)

    if ([string]::IsNullOrWhiteSpace($TargetPath)) {
        throw 'Target is empty. Pass -Target <SMB or local path>.'
    }

    $full = [System.IO.Path]::GetFullPath($TargetPath)
    if ($full -match '^[A-Za-z]:\\' -and $full.Substring(0, 1) -ieq 'C') {
        throw "Refusing target on C:. Backups must not live on the drive being wiped. Target: $full"
    }
    if ($full -match '^([A-Za-z]):\\') {
        $targetLetter = $Matches[1]
        $targetPartition = Get-Partition -DriveLetter $targetLetter -ErrorAction SilentlyContinue | Select-Object -First 1
        $systemPartition = Get-Partition -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $targetPartition -and $null -ne $systemPartition -and
            [int]$targetPartition.DiskNumber -eq [int]$systemPartition.DiskNumber) {
            throw "Refusing target on the same physical disk as C:. Target: $full"
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
    if ($FullImage) {
        Write-Host 'This will image C:, copy your data, leave regenerable folders behind, and change files on the target.' -ForegroundColor Red
    }
    else {
        Write-Host 'This will copy your data, leave regenerable folders behind, and change files on the target.' -ForegroundColor Red
    }
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
        [switch]$Quiet
    )

    $sourceFiles = Get-TreeFiles -Root $Source
    $destFiles = Get-TreeFiles -Root $Destination
    if ($sourceFiles.Count -ne $destFiles.Count) {
        throw "File count mismatch. Source $($sourceFiles.Count), destination $($destFiles.Count)."
    }

    $sourceRoot = (ConvertTo-LongPath (Resolve-Path -LiteralPath $Source).Path).TrimEnd('\')
    $destRoot = (ConvertTo-LongPath (Resolve-Path -LiteralPath $Destination).Path).TrimEnd('\')
    $manifest = New-Object System.Collections.Generic.List[object]
    $checked = 0

    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
        $destPath = $destRoot + '\' + $relative
        if (-not [System.IO.File]::Exists((ConvertTo-LongPath $destPath))) {
            throw "Missing copy: $relative"
        }
        $destItem = [System.IO.FileInfo]::new((ConvertTo-LongPath $destPath))
        if ($destItem.Length -ne $file.Length) {
            throw "Size mismatch: $relative"
        }
        $sourceHash = Get-Sha256 -Path $file.FullName
        $destHash = Get-Sha256 -Path $destPath
        if ($sourceHash -ne $destHash) {
            throw "SHA256 mismatch: $relative"
        }
        $manifest.Add([pscustomobject]@{
            RelativePath = $relative
            Bytes        = [long]$file.Length
            Sha256       = $sourceHash
        })
        $checked++
        if (-not $Quiet -and ($checked % 500) -eq 0) {
            Write-Host "    verified $checked files..."
        }
    }

    return $manifest
}

function Copy-TreeAndVerify {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ManifestPath = ''
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
        & $robocopy.Source @robocopyArgs | Out-Null
        $code = $LASTEXITCODE
        if ($code -ge 8) {
            throw "robocopy failed with exit code $code for $Source"
        }
    }
    else {
        Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
    }

    $manifest = Test-TreeHashes -Source $Source -Destination $Destination

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

function Invoke-WbadminImage {
    param([string]$TargetPath)

    $wbadmin = Get-Command wbadmin.exe -ErrorAction SilentlyContinue
    if ($null -eq $wbadmin) {
        throw 'wbadmin.exe is not available. Windows Server Backup is missing; enable it or use a Windows edition that ships it. No image was written.'
    }

    $arguments = @(
        'start',
        'backup',
        "-backupTarget:$TargetPath",
        '-include:C:',
        '-allCritical',
        '-quiet'
    )

    Write-Host "    wbadmin $($arguments -join ' ')"
    Write-Host '    (VSS quiesces the writers, including SQLite.)'
    & $wbadmin.Source @arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "wbadmin failed with exit code $code."
    }
    Write-Host '    disk image complete'
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
    if ($FullImage -and $Scope -ne 'Full') {
        throw '-FullImage requires -Scope Full. A fixture copy never includes a disk image.'
    }
    $sources = Get-SourcePlan -Fixture $FixtureRoot -Claude $SourceClaude -Data $SourceData

    foreach ($item in $sources) {
        if (-not (Test-Path -LiteralPath $item.Source -PathType Container)) {
            if ($item.Optional) { continue }
            throw "Source folder does not exist: $($item.Source)"
        }
    }
    $sources = @($sources | Where-Object { Test-Path -LiteralPath $_.Source -PathType Container })

    Assert-SafeTarget -TargetPath $Target -Sources @($sources | ForEach-Object { $_.Source })

    Write-Step 'Plan'
    Write-Host "    mode:        $(if ($Apply) { 'APPLY' } else { 'DRY RUN (default)' })"
    Write-Host "    scope:       $Scope"
    Write-Host "    target:      $Target"
    Write-Host "    repo:        $script:RepoRoot"
    foreach ($item in $sources) {
        if ($Scope -eq 'Small') {
            $size = Get-PathSizeBytes -Path $item.Source
            Write-Host ("    source:      {0} ({1})" -f $item.Source, (Format-Bytes $size))
        }
        else {
            Write-Host ("    source:      {0} (size covered by the estimate below)" -f $item.Source)
        }
    }
    if ($StopServer) {
        Write-Host '    stop server: yes (scripts/personal/stop.ps1)'
    }
    else {
        Write-Host '    stop server: no (copying a live SQLite database is not consistent)'
    }

    $targetFree = Get-FreeSpaceBytes -Path $Target
    $needed = [long]0
    foreach ($item in $sources) {
        $script:ExcludeDirs = @(Get-ReleaseExclusions -Source $item.Source)
        $needed += (Get-PathSizeBytes -Path $item.Source)
    }
    $script:ExcludeDirs = @()
    if ($FullImage) {
        $cDrive = New-Object System.IO.DriveInfo('C:\')
        $needed += ([long]$cDrive.TotalSize - [long]$cDrive.TotalFreeSpace)
    }
    # 10% margin for file-system overhead and the manifests.
    $needed = [long]($needed * 1.10)

    Write-Step 'Free-space check'
    if ($FullImage) {
        Write-Host ("    estimated need (C: image + data copies + margin): {0}" -f (Format-Bytes $needed))
    }
    else {
        Write-Host ("    estimated need (data copies + manifests + margin): {0}" -f (Format-Bytes $needed))
    }
    Write-Host '    estimate is conservative; Apply uses the same number as its gate'
    if ($null -eq $targetFree) {
        Write-Host '    target free space: unknown (unmapped UNC path); check the share before -Apply' -ForegroundColor Yellow
    }
    else {
        Write-Host ("    target free space: {0}" -f (Format-Bytes $targetFree))
        if ($targetFree -lt $needed) {
            throw "Not enough free space on target. Need about $(Format-Bytes $needed), have $(Format-Bytes $targetFree)."
        }
        Write-Host '    PASS free space'
    }

    Write-Step 'Data scope'
    if ($FullImage) {
        $wbadmin = Get-Command wbadmin.exe -ErrorAction SilentlyContinue
        if ($null -eq $wbadmin) {
            if ($Apply) {
                throw 'wbadmin.exe is not available. Windows Server Backup is missing; enable it before -Apply. No image was written and no data was copied.'
            }
            Write-Host '    wbadmin.exe: NOT AVAILABLE (Apply would fail with a clear message)' -ForegroundColor Yellow
        }
        else {
            Write-Host "    wbadmin.exe: $($wbadmin.Source)"
        }
        Write-DryCommand "wbadmin start backup -backupTarget:$Target -include:C: -allCritical -quiet"
    }
    else {
        Write-Host '    no full disk image (default; pass -FullImage to capture C: with wbadmin)'
    }
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
    Write-Plan "winget list, node/npm/pnpm/git/python versions, scheduled tasks, firewall rules and ports, Brave profiles, system info -> $Target\inventory"

    if (-not $Apply) {
        Write-Step 'Dry run complete'
        Write-Host '    Nothing was stopped, copied or written.' -ForegroundColor Green
        Write-Host "    To apply: add -Apply (and -StopServer for a consistent SQLite copy), then type $($script:ConfirmPhrase)." -ForegroundColor Green
        exit 0
    }

    Resolve-Confirmation -Supplied $ConfirmText

    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }

    if ($StopServer) {
        Write-Step 'Stopping hbots'
        Invoke-StopServer -Root $script:RepoRoot
    }
    else {
        Write-Step 'Stopping hbots (skipped)'
        Write-Host '    WARNING: the SQLite database may be copied mid-write. Pass -StopServer.' -ForegroundColor Yellow
    }

    if ($FullImage) {
        Write-Step 'Full disk image'
        Invoke-WbadminImage -TargetPath $Target
    }

    Write-Step 'Plain copies'
    $plainRoot = Join-Path $Target 'plain'
    foreach ($item in $sources) {
        $destination = Join-Path $plainRoot $item.DestinationName
        $manifestPath = Join-Path (Join-Path $Target 'inventory') ("hash-" + $item.Name + ".csv")
        $script:ExcludeDirs = @(Get-ReleaseExclusions -Source $item.Source)
        $manifest = Copy-TreeAndVerify -Source $item.Source -Destination $destination -ManifestPath $manifestPath
        Write-Host ("    {0}: {1} files verified" -f $item.Name, $manifest.Count)
    }

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
    $leftBehind.Add('Provider sign-ins (Claude, Codex, OpenCode, Antigravity, GitHub) are re-approved after install; their token stores are not copied.')
    $leftBehind.Add('Browser profiles hbots owns live under .personal-bots data roots and are copied with them; Harout''s own Brave profile is not.')
    Set-Content -LiteralPath (Join-Path (Join-Path $Target 'inventory') 'left-behind.txt') -Value $leftBehind -Encoding ASCII

    Write-Step 'Done'
    Write-Host "    Data, manifests and inventory are under $Target" -ForegroundColor Green
    Write-Host '    Keep the copy for at least one week after Omarchy is live.' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
