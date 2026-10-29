<#
.SYNOPSIS
    Verify the Omarchy ISO and, only when asked, write it to a USB stick.

.DESCRIPTION
    ISO only. There is no second stick and no installer answer file (removed
    25 Oct 2026): Harout's Omarchy installer stick is already written and
    verified, and he answers the installer's few questions himself. SSH access
    after install comes from migrate/linux/enable-ssh.sh, not from a stick.

    Default is a DRY RUN. It downloads nothing, prompts for nothing and writes
    nothing; it prints the ISO version, the published checksum, every disk with
    its model, size and bus, and the exact command it would run.

    -Apply writes, but only after the operator types the exact model string of
    the stick. The system disk and any disk holding C: or this repo are always
    refused. A non-removable disk is refused unless -AllowFixed is given, and
    that switch exists only for throwaway image-file tests.

.PARAMETER ImageFile
    Test mode: write the ISO to a plain file instead of a physical disk.

.PARAMETER SelfTest
    Run the offline test suite (checksum parsing, mismatch rejection, raw image
    write, disk guards, exact-model confirmation). No network, no real disk.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -Apply -IsoDiskNumber 3 -EraseDisk

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [switch]$Apply,

    [switch]$SelfTest,

    [string]$ImageFile = '',

    [int]$IsoDiskNumber = -1,

    [switch]$EraseDisk,

    [switch]$AllowFixed,

    [string]$ConfirmText = '',

    [string]$Version = '',

    [string]$IsoPath = '',

    [string]$IsoUrl = '',

    [string]$ChecksumUrl = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$script:DefaultIsoOrigin = 'https://iso.omarchy.org'
$script:DefaultReleaseApi = 'https://api.github.com/repos/omacom/omarchy/releases/latest'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

function Write-DryCommand {
    param([string]$Command)
    Write-Host '    DRY RUN would run:'
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
    $stream = [System.IO.File]::Open((ConvertTo-LongPath $Path), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $bytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

# ---------------------------------------------------------------- ISO

function Get-LatestOmarchyVersion {
    $release = Invoke-RestMethod -Uri $script:DefaultReleaseApi -Headers @{ 'User-Agent' = 'hbots-migrate' } -TimeoutSec 30
    if ($null -eq $release -or [string]::IsNullOrWhiteSpace($release.tag_name)) {
        throw 'GitHub release lookup returned no tag_name.'
    }
    return $release.tag_name.TrimStart('v')
}

function Get-PublishedChecksum {
    param([string]$Version, [string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        $Url = "$($script:DefaultIsoOrigin)/omarchy-$Version.iso.sha256"
    }
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 30
    if ($response.Content -is [byte[]]) {
        $text = [System.Text.Encoding]::ASCII.GetString($response.Content)
    }
    else {
        $text = [string]$response.Content
    }
    $parts = $text.Trim() -split '\s+'
    if ($parts.Count -lt 2 -or $parts[0] -notmatch '^[0-9a-fA-F]{64}$') {
        throw "Published checksum at $Url is not in '<sha256>  <file>' form."
    }
    return [pscustomobject]@{
        Hash     = $parts[0].ToLowerInvariant()
        FileName = $parts[1]
        Url      = $Url
    }
}

function Test-IsoChecksum {
    param([string]$Path, [string]$ExpectedHash, [string]$ExpectedFileName)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "ISO not found: $Path"
    }
    $actual = Get-Sha256 -Path $Path
    if ($actual -ne $ExpectedHash.ToLowerInvariant()) {
        throw "SHA256 mismatch for $Path. Expected $ExpectedHash, got $actual. The file was not deleted; remove it yourself and re-run."
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedFileName)) {
        $leaf = Split-Path -Leaf $Path
        if ($leaf -ne $ExpectedFileName) {
            throw "Checksum file names $ExpectedFileName but the local file is $leaf. Rename it or pass -IsoPath."
        }
    }
    return $actual
}

function Resolve-OmarchyIso {
    param(
        [string]$RequestedVersion,
        [string]$Path,
        [string]$DownloadUrl,
        [string]$ChecksumAddress,
        [switch]$Download
    )

    $resolvedVersion = $RequestedVersion
    if ([string]::IsNullOrWhiteSpace($resolvedVersion)) {
        if ($Download) {
            $resolvedVersion = Get-LatestOmarchyVersion
        }
        else {
            try { $resolvedVersion = Get-LatestOmarchyVersion }
            catch {
                Write-Host ('    latest version lookup failed: ' + $_.Exception.Message) -ForegroundColor Yellow
                $resolvedVersion = 'unknown'
            }
        }
    }

    $checksum = $null
    if ($resolvedVersion -ne 'unknown') {
        try {
            $checksum = Get-PublishedChecksum -Version $resolvedVersion -Url $ChecksumAddress
            $expectedFile = $checksum.FileName
        }
        catch {
            if ($Download) { throw }
            Write-Host ('    checksum lookup failed: ' + $_.Exception.Message) -ForegroundColor Yellow
            $expectedFile = "omarchy-$resolvedVersion.iso"
        }
    }
    else {
        $expectedFile = 'omarchy-<version>.iso'
    }

    if ([string]::IsNullOrWhiteSpace($DownloadUrl)) {
        if ($resolvedVersion -ne 'unknown') { $DownloadUrl = "$($script:DefaultIsoOrigin)/omarchy-$resolvedVersion.iso" }
        else { $DownloadUrl = "$($script:DefaultIsoOrigin)/omarchy-<version>.iso" }
    }
    if ([string]::IsNullOrWhiteSpace($Path)) {
        $leaf = if ($expectedFile) { $expectedFile } else { 'omarchy.iso' }
        $Path = Join-Path $env:TEMP $leaf
    }

    Write-Info "version:  $resolvedVersion"
    Write-Info "ISO:      $DownloadUrl"
    if ($null -ne $checksum) {
        Write-Info "checksum: $($checksum.Url)"
        Write-Info "SHA256:   $($checksum.Hash)"
    }
    Write-Info "local:    $Path"

    if (-not $Download) {
        if (Test-Path -LiteralPath $Path) {
            $existing = Get-Sha256 -Path $Path
            if ($null -ne $checksum -and $existing -ne $checksum.Hash) {
                throw "Existing ISO at $Path does not match the published checksum. It was not deleted; remove it or pass another -IsoPath."
            }
            Write-Info 'existing ISO matches the published checksum; no download needed'
        }
        else {
            Write-Info 'ISO is not downloaded yet'
        }
        return [pscustomobject]@{
            Version  = $resolvedVersion
            Path     = $Path
            Url      = $DownloadUrl
            Checksum = $checksum
            FileName = $expectedFile
        }
    }

    if ($null -eq $checksum) {
        throw 'Cannot download without the published checksum. Check the network and the version.'
    }
    if ($checksum.FileName -ne (Split-Path -Leaf $Path)) {
        throw "The published checksum names $($checksum.FileName) but -IsoPath ends in $(Split-Path -Leaf $Path). Use matching names."
    }

    if (Test-Path -LiteralPath $Path) {
        $existing = Get-Sha256 -Path $Path
        if ($existing -eq $checksum.Hash) {
            Write-Info 'ISO already present and verified'
            return [pscustomobject]@{ Version = $resolvedVersion; Path = $Path; Url = $DownloadUrl; Checksum = $checksum; FileName = $expectedFile }
        }
        throw "Existing ISO at $Path does not match the published checksum. It was not deleted; remove it or pass another -IsoPath."
    }

    $partial = $Path + '.partial'
    if (Test-Path -LiteralPath $partial) { throw "Partial download already exists at $partial. Remove it yourself and re-run." }
    Write-Info "downloading to $partial"
    Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $partial -TimeoutSec 3600
    $actual = Get-Sha256 -Path $partial
    if ($actual -ne $checksum.Hash) {
        throw "Downloaded ISO SHA256 mismatch. Partial kept at $partial; remove it yourself. Expected $($checksum.Hash), got $actual."
    }
    Move-Item -LiteralPath $partial -Destination $Path
    Write-Info 'download verified'
    return [pscustomobject]@{ Version = $resolvedVersion; Path = $Path; Url = $DownloadUrl; Checksum = $checksum; FileName = $expectedFile }
}

# ---------------------------------------------------------------- disks

function Get-DiskReport {
    Write-Step 'Disks'
    $systemDisk = $null
    $cPartition = Get-Partition -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cPartition) { $systemDisk = [int]$cPartition.DiskNumber }

    $rows = foreach ($disk in (Get-Disk | Sort-Object Number)) {
        $marker = ''
        if ($disk.IsSystem -or $disk.IsBoot -or $disk.Number -eq $systemDisk) { $marker = ' SYSTEM' }
        if ($disk.BusType -ne 'USB') { $marker += ' FIXED' }
        [pscustomobject]@{
            Number          = $disk.Number
            Model           = $disk.FriendlyName
            SizeGB          = [math]::Round($disk.Size / 1GB, 1)
            Bus             = [string]$disk.BusType
            PartitionStyle  = [string]$disk.PartitionStyle
            Partitions      = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue).Count
            Flags           = $marker.Trim()
        }
    }
    $rows | Format-Table -AutoSize | Out-String | Write-Host
    return [pscustomobject]@{ SystemDisk = $systemDisk; Disks = @($rows) }
}

function Assert-DiskSafe {
    param(
        [object]$Disk,
        [string]$Purpose,
        [string]$RepoRoot,
        [switch]$AllowFixedDisk
    )

    if ($null -eq $Disk) { throw "No disk selected for $Purpose." }
    if ($Disk.IsSystem -or $Disk.IsBoot) {
        throw "Refusing $Purpose on disk $($Disk.Number): it is the system or boot disk."
    }
    $cPartition = Get-Partition -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cPartition -and [int]$cPartition.DiskNumber -eq [int]$Disk.Number) {
        throw "Refusing $Purpose on disk $($Disk.Number): it holds C:."
    }
    if ([string]$Disk.BusType -ne 'USB' -and -not $AllowFixedDisk) {
        throw "Refusing $Purpose on disk $($Disk.Number): bus is $($Disk.BusType), not USB. Pass -AllowFixed only for a throwaway image-file test."
    }
    if (-not [string]::IsNullOrWhiteSpace($RepoRoot)) {
        foreach ($partition in (Get-Partition -DiskNumber $Disk.Number -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace($partition.DriveLetter)) { continue }
            $root = $partition.DriveLetter + ':\'
            if ($RepoRoot.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing $Purpose on disk $($Disk.Number): it holds this repo ($root)."
            }
        }
    }
}

function Resolve-DiskConfirmation {
    param([object]$Disk, [string]$Supplied, [switch]$Quiet)

    if (-not [string]::IsNullOrWhiteSpace($Supplied)) {
        if ($Supplied -cne $Disk.FriendlyName) {
            throw "Wrong confirmation for disk $($Disk.Number). Expected exactly the model: $($Disk.FriendlyName)"
        }
        return
    }
    if ($Quiet) {
        throw "Apply needs -ConfirmText with the exact model for disk $($Disk.Number): $($Disk.FriendlyName)"
    }
    Write-Host ''
    Write-Host "About to erase ALL data on disk $($Disk.Number): $($Disk.FriendlyName) ($([math]::Round($Disk.Size / 1GB, 1)) GB, $($Disk.BusType))" -ForegroundColor Red
    $typed = Read-Host "Type the exact model to continue"
    if ($typed -cne $Disk.FriendlyName) {
        throw 'Confirmation did not match. Nothing was written.'
    }
}

function Clear-TargetDisk {
    param([object]$Disk, [switch]$Erase)

    $partitions = @(Get-Partition -DiskNumber $Disk.Number -ErrorAction SilentlyContinue)
    if ($partitions.Count -gt 0 -and -not $Erase) {
        throw "Disk $($Disk.Number) still has $($partitions.Count) partition(s). Re-run with -EraseDisk after checking the model, or wipe it yourself first."
    }
    if ($Erase) {
        Write-Info "erasing partition table on disk $($Disk.Number)"
        Clear-Disk -Number $Disk.Number -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop | Out-Null
        Update-HostStorageCache -ErrorAction SilentlyContinue
    }
}

function Write-RawImage {
    param(
        [string]$ImagePath,
        [string]$TargetFile = '',
        [int]$PhysicalDiskNumber = -1,
        [switch]$ApplyImage
    )

    if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
        throw "Image to write does not exist: $ImagePath"
    }
    $source = [System.IO.File]::OpenRead((ConvertTo-LongPath $ImagePath))

    if (-not [string]::IsNullOrWhiteSpace($TargetFile)) {
        $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($TargetFile))
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $target = [System.IO.File]::Open((ConvertTo-LongPath $TargetFile), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    }
    else {
        if (-not $ApplyImage) {
            throw 'Refusing a raw device write without -Apply.'
        }
        if ($PhysicalDiskNumber -lt 0) { throw 'No physical disk number for the raw write.' }
        $target = $null
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                $target = [System.IO.File]::Open("\\.\PhysicalDrive$PhysicalDiskNumber", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                break
            }
            catch {
                if ($attempt -eq 5) {
                    throw "Cannot open \\.\PhysicalDrive$PhysicalDiskNumber for writing after 5 attempts. Run as Administrator and use -EraseDisk. $($_.Exception.Message)"
                }
                Start-Sleep -Seconds 1
            }
        }
    }

    try {
        $buffer = New-Object byte[] (4MB)
        $total = [long]0
        while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $target.Write($buffer, 0, $read)
            $total += $read
        }
        $target.Flush($true)
        Write-Info "wrote $total bytes"
    }
    finally {
        $source.Dispose()
        $target.Dispose()
    }
}

# ---------------------------------------------------------------- self-test

function Invoke-SelfTest {
    $root = Join-Path $env:TEMP ('make-installer-selftest-' + [guid]::NewGuid().ToString('N'))

    try {
        Write-Step 'make-installer self-test'
        New-Item -ItemType Directory -Path $root -Force | Out-Null

        # 1. ISO checksum parsing and verification.
        $iso = Join-Path $root 'omarchy-test.iso'
        $bytes = New-Object byte[] (1MB)
        (New-Object System.Random(7)).NextBytes($bytes)
        [System.IO.File]::WriteAllBytes($iso, $bytes)
        $expected = Get-Sha256 -Path $iso
        $null = Test-IsoChecksum -Path $iso -ExpectedHash $expected -ExpectedFileName 'omarchy-test.iso'
        Write-Host 'PASS ISO SHA256 match'

        $detected = $false
        try { $null = Test-IsoChecksum -Path $iso -ExpectedHash ('0' * 64) -ExpectedFileName 'omarchy-test.iso' }
        catch { $detected = $true }
        if (-not $detected) { throw 'a bad ISO checksum was accepted' }
        Write-Host 'PASS ISO SHA256 mismatch is rejected'

        # 2. Raw image writer to a plain file.
        $rawTarget = Join-Path $root 'raw-write.bin'
        Write-RawImage -ImagePath $iso -TargetFile $rawTarget
        if ((Get-Sha256 -Path $rawTarget) -ne (Get-Sha256 -Path $iso)) { throw 'raw image write did not round-trip' }
        Write-Host 'PASS buffered image write and flush'

        # 3. Disk guards with synthetic disks.
        $system = [pscustomobject]@{ Number = 0; FriendlyName = 'System Disk'; Size = 512GB; BusType = 'NVMe'; IsSystem = $true; IsBoot = $true }
        $fixed = [pscustomobject]@{ Number = 1; FriendlyName = 'Fixed Disk'; Size = 512GB; BusType = 'NVMe'; IsSystem = $false; IsBoot = $false }
        $removable = [pscustomobject]@{ Number = 99; FriendlyName = 'USB Test'; Size = 32GB; BusType = 'USB'; IsSystem = $false; IsBoot = $false }
        $rejected = $false
        try { Assert-DiskSafe -Disk $system -Purpose 'test' -RepoRoot '' } catch { $rejected = $true }
        if (-not $rejected) { throw 'system disk was accepted' }
        $rejected = $false
        try { Assert-DiskSafe -Disk $fixed -Purpose 'test' -RepoRoot '' } catch { $rejected = $true }
        if (-not $rejected) { throw 'fixed disk was accepted without -AllowFixed' }
        Assert-DiskSafe -Disk $removable -Purpose 'test' -RepoRoot '' -AllowFixedDisk
        Write-Host 'PASS disk guards'

        # 4. Confirmation.
        $rejected = $false
        try { Resolve-DiskConfirmation -Disk $removable -Supplied 'wrong model' -Quiet } catch { $rejected = $true }
        if (-not $rejected) { throw 'wrong model confirmation was accepted' }
        Resolve-DiskConfirmation -Disk $removable -Supplied 'USB Test' -Quiet
        Write-Host 'PASS exact model confirmation'

        Write-Host 'SELFTEST PASS' -ForegroundColor Green
        return 0
    }
    catch {
        Write-Host ('SELFTEST FAIL: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host $_.ScriptStackTrace
        return 1
    }
    finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------- main

if ($SelfTest) {
    if ($Apply) { throw '-SelfTest and -Apply cannot be combined.' }
    exit (Invoke-SelfTest)
}

try {
    Write-Step 'Omarchy installer (ISO only)'
    $iso = Resolve-OmarchyIso -RequestedVersion $Version -Path $IsoPath -DownloadUrl $IsoUrl -ChecksumAddress $ChecksumUrl -Download:$false
    $report = Get-DiskReport
    $isoDisk = $null

    if ($IsoDiskNumber -ge 0) {
        $isoDisk = Get-Disk -Number $IsoDiskNumber -ErrorAction Stop
        Assert-DiskSafe -Disk $isoDisk -Purpose 'ISO stick' -RepoRoot (Get-Location).Path -AllowFixedDisk:$AllowFixed
        Write-Info "ISO stick:   $($isoDisk.Number) $($isoDisk.FriendlyName) ($([math]::Round($isoDisk.Size / 1GB, 1)) GB)"
    }
    else {
        Write-Info 'No -IsoDiskNumber given. Pick one from the table above.'
    }

    if (-not $Apply) {
        Write-Step 'Dry run complete'
        if (Test-Path -LiteralPath $iso.Path) {
            Write-Info "ISO is present: $($iso.Path)"
        }
        else {
            Write-Info "ISO would be downloaded to $($iso.Path) and checked against the published SHA256"
        }
        if ($IsoDiskNumber -ge 0) {
            Write-DryCommand "write $($iso.Path) raw to \\.\PhysicalDrive$IsoDiskNumber"
        }
        else {
            Write-Info 'ISO write would go to the stick chosen with -IsoDiskNumber'
        }
        Write-Info 'the installer asks its own questions on the laptop; no answer file is used'
        Write-Host '    Nothing was downloaded, written or erased.' -ForegroundColor Green
        exit 0
    }

    if ($IsoDiskNumber -lt 0 -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        throw 'Apply needs -IsoDiskNumber (or -ImageFile for a file test).'
    }

    if (-not (Test-Path -LiteralPath $iso.Path)) {
        Write-Step 'Downloading ISO'
        $iso = Resolve-OmarchyIso -RequestedVersion $Version -Path $iso.Path -DownloadUrl $iso.Url -ChecksumAddress $ChecksumUrl -Download
    }

    if ($null -ne $isoDisk -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        $isoFileSize = (Get-Item -LiteralPath $iso.Path).Length
        if ($isoFileSize -gt $isoDisk.Size) { throw "The ISO ($isoFileSize bytes) does not fit on disk $IsoDiskNumber ($($isoDisk.Size) bytes)." }
    }

    if ($null -ne $isoDisk -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        Resolve-DiskConfirmation -Disk $isoDisk -Supplied $ConfirmText
        Clear-TargetDisk -Disk $isoDisk -Erase:$EraseDisk
    }

    Write-Step 'Writing ISO'
    if ([string]::IsNullOrWhiteSpace($ImageFile)) {
        Write-RawImage -ImagePath $iso.Path -PhysicalDiskNumber $IsoDiskNumber -ApplyImage
    }
    else {
        Write-Info "test mode: ISO -> $ImageFile"
        Write-RawImage -ImagePath $iso.Path -TargetFile $ImageFile
    }

    Write-Step 'Done'
    Write-Host 'Omarchy ISO stick written and verified.' -ForegroundColor Green
    Write-Host 'Next: F2 Secure Boot off, F12 boot the ISO stick, answer the installer questions, then paste the enable-ssh one-liner from migrate/linux/enable-ssh.sh.' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
