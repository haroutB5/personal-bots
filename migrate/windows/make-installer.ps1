<#
.SYNOPSIS
    Build the two Omarchy install sticks: the ISO stick and the cidata stick.

.DESCRIPTION
    Default is a DRY RUN. It downloads nothing, prompts for nothing and writes
    nothing; it prints the ISO version, the published checksum, every disk with
    its model, size and bus, and the exact commands it would run.

    -Apply writes, but only after the operator types the exact model string of
    each stick. The system disk and any disk holding C: or this repo are always
    refused. A non-removable disk is refused unless -AllowFixed is given, and
    that switch exists only for throwaway image-file tests.

    Stick 1: Omarchy ISO, written raw to \\.\PhysicalDriveN.
    Stick 2: a small FAT32 volume labelled CIDATA with the unattended-install
             files. Omarchy reads it as a second drive. A single stick does NOT
             work with the supported flow because the ISO is written to the
             whole device and destroys any second partition. Use two sticks.

    cidata files (schema from omarchy.org/manual/unattended-installs and the
    omarchy-iso integration harness):
      user_configuration.json   archinstall config: disk, hostname, timezone,
                                keyboard, locale, packages
      user_credentials.json     username and a SHA-512 crypt password hash
      user_encrypt_installation.txt  "false" (this script does not encrypt)
      authorized_keys           one public key per line
      hostname                  informational copy; the installer reads the
                                effective hostname from user_configuration.json

    The password is typed into Read-Host -AsSecureString. It is passed to
    openssl.exe on stdin, never on the command line, and only the hash is
    written. The password is never printed or logged.

.PARAMETER ImageFile
    Test mode: write the ISO (or, with -BuildCidataOnly, the cidata image) to a
    plain file instead of a physical disk.

.PARAMETER BuildCidataOnly
    Build only the cidata image or stick. No ISO download and no ISO write.

.PARAMETER SelfTest
    Run the offline test suite (checksum parsing, openssl hash on stdin, cidata
    image build and read-back, raw image write to a temp file, disk guards).
    Exits 0 or 1. No network, no real disk, no password prompt.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -Apply -IsoDiskNumber 3 -CidataDiskNumber 4 -EraseDisk
#>
[CmdletBinding()]
param(
    [switch]$Apply,

    [switch]$SelfTest,

    [switch]$BuildCidataOnly,

    [string]$ImageFile = '',

    [string]$CidataImage = '',

    [int]$IsoDiskNumber = -1,

    [int]$CidataDiskNumber = -1,

    [switch]$EraseDisk,

    [switch]$AllowFixed,

    [string]$ConfirmText = '',

    [string]$Version = '',

    [string]$IsoPath = '',

    [string]$IsoUrl = '',

    [string]$ChecksumUrl = '',

    [string]$AuthorizedKeysPath = (Join-Path (Join-Path $env:USERPROFILE '.ssh') 'authorized_keys'),

    [string]$Username = 'harout',

    [string]$Hostname = 'hbots',

    [string]$Timezone = 'Europe/London',

    [string]$Keyboard = 'gb',

    [string]$DiskDevice = '/dev/nvme0n1',

    [long]$DiskBytes = 512110190592,

    [int]$CidataSizeMB = 64
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$script:SelfTestPassword = 'SELFTEST-ONLY-password-9f3a'
$script:DefaultIsoOrigin = 'https://iso.omarchy.org'
$script:DefaultReleaseApi = 'https://api.github.com/repos/omacom/omarchy/releases/latest'
$script:Mib = 1MB
$script:Gib = 1GB

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

function Find-OpenSsl {
    $command = Get-Command openssl.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
        (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Git\usr\bin\openssl.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\openssl.exe')
    )
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'openssl.exe not found. Install Git for Windows (it ships openssl.exe) or put openssl on PATH.'
}

function ConvertFrom-SecureStringPlain {
    param([System.Security.SecureString]$Secure)
    $bstr = [System.IntPtr]::Zero
    try {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        if ($bstr -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function New-SecureStringFromPlain {
    param([string]$Plain)
    return (ConvertTo-SecureString -String $Plain -AsPlainText -Force)
}

function Read-OperatorPassword {
    param([string]$User)

    if ($SelfTest) {
        return (New-SecureStringFromPlain $script:SelfTestPassword)
    }

    Write-Host ''
    Write-Host "Password for the Omarchy user '$User' (typed locally, never shown):"
    $first = Read-Host -AsSecureString 'Password'
    $second = Read-Host -AsSecureString 'Repeat password'
    $a = ConvertFrom-SecureStringPlain $first
    $b = ConvertFrom-SecureStringPlain $second
    try {
        if ($a -cne $b) { throw 'Passwords do not match. Nothing was written.' }
        if ([string]::IsNullOrEmpty($a)) { throw 'Password is empty. Nothing was written.' }
    }
    finally {
        $a = $null
        $b = $null
    }
    return $first
}

function Get-CryptHash {
    param([System.Security.SecureString]$Secure, [string]$OpenSsl)

    $plain = ConvertFrom-SecureStringPlain $Secure
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $OpenSsl
        $start.Arguments = 'passwd -6 -stdin'
        $start.UseShellExecute = $false
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.CreateNoWindow = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $start
        [void]$process.Start()
        $process.StandardInput.WriteLine($plain)
        $process.StandardInput.Close()
        $hash = $process.StandardOutput.ReadToEnd().Trim()
        $stderr = $process.StandardError.ReadToEnd().Trim()
        $process.WaitForExit()

        if ($process.ExitCode -ne 0) {
            throw "openssl passwd failed with exit code $($process.ExitCode). $stderr"
        }
        if ($hash -notmatch '^\$6\$[A-Za-z0-9./]+\$[A-Za-z0-9./]+$') {
            throw 'openssl did not return a SHA-512 crypt hash.'
        }
        return $hash
    }
    finally {
        $plain = $null
    }
}

function Read-AuthorizedKeys {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "authorized_keys not found at $Path. Put the CTO laptop and gaming PC public keys there, one per line, or pass -AuthorizedKeysPath."
    }

    $keys = New-Object System.Collections.Generic.List[string]
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        if ($trimmed -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s+[A-Za-z0-9+/=]+(\s+.+)?$') {
            throw "authorized_keys has a line that is not an OpenSSH public key. Key contents were not printed."
        }
        $keys.Add($trimmed)
    }

    if ($keys.Count -eq 0) {
        throw "authorized_keys at $Path has no usable keys. Omarchy fails an unattended install whose authorized_keys is empty."
    }
    return $keys.ToArray()
}

function Test-NameValue {
    param([string]$Name, [string]$Pattern, [string]$Label)
    if ($Name -notmatch $Pattern) {
        throw "$Label is invalid: $Name"
    }
}

function New-CidataPayload {
    param(
        [string]$User,
        [string]$Machine,
        [string]$Zone,
        [string]$Layout,
        [string]$Device,
        [long]$Bytes,
        [string]$PasswordHash,
        [string[]]$AuthorizedKeys
    )

    Test-NameValue -Name $User -Pattern '^[a-z_][a-z0-9_-]{0,31}$' -Label 'username'
    if ($User -eq 'root') { throw 'username must not be root.' }
    Test-NameValue -Name $Machine -Pattern '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' -Label 'hostname'
    if ($Bytes -lt 20GB) { throw "DiskBytes is too small for a full Omarchy install: $Bytes" }

    $mib = $script:Mib
    $gib = $script:Gib
    $bootStart = $mib
    $bootSize = 2 * $gib
    $mainStart = $bootStart + $bootSize
    $mainSize = $Bytes - $mainStart - $mib
    if ($mainSize -le 10GB) { throw "DiskBytes leaves no room for the root partition: $Bytes" }

    $bootId = [guid]::NewGuid().ToString()
    $mainId = [guid]::NewGuid().ToString()

    $configuration = [ordered]@{
        'app_config'           = $null
        'archinstall-language' = 'English'
        'auth_config'          = [ordered]@{}
        'audio_config'         = [ordered]@{ audio = 'pipewire' }
        'bootloader_config'    = [ordered]@{ bootloader = 'Limine'; uki = $false; removable = $false }
        'custom_commands'      = @()
        'omarchy_install'      = [ordered]@{
            mode                = 'full_disk'
            defer_provisioning  = $false
            target_mount        = '/mnt'
            boot                = [ordered]@{
                esp_mount        = '/boot'
                esp_path         = '/EFI/limine'
                efi_binary       = 'limine_x64.efi'
                enable_fallback  = $true
            }
            storage             = [ordered]@{ kernel = 'linux-omarchy' }
        }
        'disk_config'          = [ordered]@{
            config_type          = 'default_layout'
            device_modifications = @(
                [ordered]@{
                    device     = $Device
                    partitions = @(
                        [ordered]@{
                            btrfs        = @()
                            dev_path     = $null
                            flags        = @('boot', 'esp')
                            fs_type      = 'fat32'
                            mount_options = @()
                            mountpoint   = '/boot'
                            obj_id       = $bootId
                            size         = [ordered]@{ sector_size = [ordered]@{ unit = 'B'; value = 512 }; unit = 'B'; value = $bootSize }
                            start        = [ordered]@{ sector_size = [ordered]@{ unit = 'B'; value = 512 }; unit = 'B'; value = $bootStart }
                            status       = 'create'
                            type         = 'primary'
                        },
                        [ordered]@{
                            btrfs        = @(
                                [ordered]@{ mountpoint = '/'; name = '@' },
                                [ordered]@{ mountpoint = '/home'; name = '@home' },
                                [ordered]@{ mountpoint = '/var/log'; name = '@log' },
                                [ordered]@{ mountpoint = '/var/cache/pacman/pkg'; name = '@pkg' }
                            )
                            dev_path     = $null
                            flags        = @()
                            fs_type      = 'btrfs'
                            mount_options = @('compress=zstd')
                            mountpoint   = $null
                            obj_id       = $mainId
                            size         = [ordered]@{ sector_size = [ordered]@{ unit = 'B'; value = 512 }; unit = 'B'; value = $mainSize }
                            start        = [ordered]@{ sector_size = [ordered]@{ unit = 'B'; value = 512 }; unit = 'B'; value = $mainStart }
                            status       = 'create'
                            type         = 'primary'
                        }
                    )
                    wipe = $true
                }
            )
        }
        'hostname'             = $Machine
        'kernels'              = @('linux-omarchy')
        'network_config'       = [ordered]@{ type = 'iso' }
        'ntp'                  = $true
        'parallel_downloads'   = 8
        'script'               = $null
        'services'             = @()
        'swap'                 = $true
        'timezone'             = $Zone
        'locale_config'        = [ordered]@{ kb_layout = $Layout; sys_enc = 'UTF-8'; sys_lang = 'en_GB.UTF-8' }
        'mirror_config'        = [ordered]@{
            custom_repositories  = @()
            custom_servers       = @(
                [ordered]@{ url = 'https://mirror.omarchy.org/$repo/os/$arch' },
                [ordered]@{ url = 'https://mirror.rackspace.com/archlinux/$repo/os/$arch' },
                [ordered]@{ url = 'https://geo.mirror.pkgbuild.com/$repo/os/$arch' }
            )
            mirror_regions       = [ordered]@{}
            optional_repositories = @()
        }
        'packages'             = @('base-devel', 'git', 'omarchy-keyring', 'omarchy-settings', 'omarchy')
        'profile_config'       = [ordered]@{ gfx_driver = $null; greeter = $null; profile = [ordered]@{} }
        'version'              = '3.0.9'
    }

    $credentials = [ordered]@{
        root_enc_password = $PasswordHash
        users             = @(
            [ordered]@{
                enc_password = $PasswordHash
                groups       = @()
                sudo         = $true
                username     = $User
            }
        )
    }

    $configurationJson = ($configuration | ConvertTo-Json -Depth 20) + "`n"
    $credentialsJson = ($credentials | ConvertTo-Json -Depth 20) + "`n"

    # Parse our own output before it can reach a stick.
    $null = $configurationJson | ConvertFrom-Json
    $null = $credentialsJson | ConvertFrom-Json

    $ascii = [System.Text.Encoding]::UTF8
    $files = [ordered]@{}
    $files['user_configuration.json'] = $ascii.GetBytes($configurationJson)
    $files['user_credentials.json'] = $ascii.GetBytes($credentialsJson)
    $files['user_encrypt_installation.txt'] = $ascii.GetBytes("false`n")
    $files['authorized_keys'] = $ascii.GetBytes((($AuthorizedKeys -join "`n") + "`n"))
    $files['hostname'] = $ascii.GetBytes($Machine + "`n")
    return $files
}

# ---------------------------------------------------------------- FAT32 writer

function Set-U16 {
    param([byte[]]$Buffer, [int]$Offset, [int]$Value)
    $Buffer[$Offset] = [byte]($Value -band 0xFF)
    $Buffer[$Offset + 1] = [byte](($Value -shr 8) -band 0xFF)
}

function Set-U32 {
    param([byte[]]$Buffer, [int]$Offset, [uint32]$Value)
    $Buffer[$Offset] = [byte]($Value -band 0xFF)
    $Buffer[$Offset + 1] = [byte](($Value -shr 8) -band 0xFF)
    $Buffer[$Offset + 2] = [byte](($Value -shr 16) -band 0xFF)
    $Buffer[$Offset + 3] = [byte](($Value -shr 24) -band 0xFF)
}

function Get-U16 {
    param([byte[]]$Buffer, [int]$Offset)
    return [int]$Buffer[$Offset] -bor ([int]$Buffer[$Offset + 1] -shl 8)
}

function Get-U32 {
    param([byte[]]$Buffer, [int]$Offset)
    return [uint32]([uint32]$Buffer[$Offset] -bor ([uint32]$Buffer[$Offset + 1] -shl 8) -bor ([uint32]$Buffer[$Offset + 2] -shl 16) -bor ([uint32]$Buffer[$Offset + 3] -shl 24))
}

function Get-ShortName {
    param([string]$Name, [hashtable]$Used)

    $upper = $Name.ToUpperInvariant()
    if ($upper -match '^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{1,3})?$' -and -not $Used.ContainsKey($upper)) {
        $Used[$upper] = $true
        return $upper
    }

    $dot = $upper.LastIndexOf('.')
    if ($dot -ge 0) {
        $base = $upper.Substring(0, $dot)
        $ext = $upper.Substring($dot + 1)
    }
    else {
        $base = $upper
        $ext = ''
    }
    $base = ($base -replace '[^A-Z0-9_]', '')
    $ext = ($ext -replace '[^A-Z0-9_]', '')
    if ($base.Length -eq 0) { $base = 'FILE' }
    if ($ext.Length -gt 3) { $ext = $ext.Substring(0, 3) }

    for ($n = 1; $n -lt 1000; $n++) {
        $prefix = $base
        if ($prefix.Length -gt 6) { $prefix = $prefix.Substring(0, 6) }
        $shortBase = ($prefix + '~' + $n).ToUpperInvariant()
        if ($shortBase.Length -gt 8) { $shortBase = $shortBase.Substring(0, 8) }
        $candidate = $shortBase
        if ($ext.Length -gt 0) { $candidate = $shortBase + '.' + $ext }
        if (-not $Used.ContainsKey($candidate)) {
            $Used[$candidate] = $true
            return $candidate
        }
    }
    throw "Could not make a short name for $Name"
}

function Get-LfnChecksum {
    param([byte[]]$ShortName)
    $sum = 0
    foreach ($b in $ShortName) {
        $sum = (((($sum -band 1) -shl 7) + ($sum -shr 1) + [int]$b) -band 0xFF)
    }
    return [byte]$sum
}

function New-LfnEntries {
    param([string]$Name, [byte[]]$ShortName)

    $checksum = Get-LfnChecksum -ShortName $ShortName
    $chars = $Name.ToCharArray()
    $chunks = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $chars.Length; $i += 13) {
        $length = [math]::Min(13, $chars.Length - $i)
        $chunks.Add((New-Object string ($chars, $i, $length)))
    }

    $entries = New-Object System.Collections.Generic.List[byte[]]
    for ($index = $chunks.Count; $index -ge 1; $index--) {
        $chunk = $chunks[$index - 1]
        $entry = New-Object byte[] 32
        $order = $index
        if ($index -eq $chunks.Count) { $order = $order -bor 0x40 }
        $entry[0] = [byte]$order
        $entry[11] = 0x0F
        $entry[12] = 0
        $entry[13] = $checksum
        $entry[26] = 0
        $entry[27] = 0

        $units = New-Object 'int[]' 13
        for ($j = 0; $j -lt 13; $j++) { $units[$j] = 0xFFFF }
        $chunkChars = $chunk.ToCharArray()
        for ($j = 0; $j -lt $chunkChars.Length; $j++) { $units[$j] = [int]$chunkChars[$j] }
        if ($index -eq $chunks.Count -and $chunkChars.Length -lt 13) {
            $units[$chunkChars.Length] = 0
        }

        $offset = 1
        for ($j = 0; $j -lt 5; $j++) { Set-U16 -Buffer $entry -Offset $offset -Value $units[$j]; $offset += 2 }
        $offset = 14
        for ($j = 5; $j -lt 11; $j++) { Set-U16 -Buffer $entry -Offset $offset -Value $units[$j]; $offset += 2 }
        $offset = 28
        for ($j = 11; $j -lt 13; $j++) { Set-U16 -Buffer $entry -Offset $offset -Value $units[$j]; $offset += 2 }

        $entries.Add($entry)
    }
    return ,$entries
}

function Get-ShortNameBytes {
    param([string]$ShortName)
    $dot = $ShortName.LastIndexOf('.')
    if ($dot -ge 0) {
        $base = $ShortName.Substring(0, $dot)
        $ext = $ShortName.Substring($dot + 1)
    }
    else {
        $base = $ShortName
        $ext = ''
    }
    $bytes = New-Object byte[] 11
    for ($i = 0; $i -lt 11; $i++) { $bytes[$i] = 0x20 }
    for ($i = 0; $i -lt $base.Length -and $i -lt 8; $i++) { $bytes[$i] = [byte][char]$base[$i] }
    for ($i = 0; $i -lt $ext.Length -and $i -lt 3; $i++) { $bytes[8 + $i] = [byte][char]$ext[$i] }
    return $bytes
}

function New-ShortEntry {
    param(
        [byte[]]$ShortName11,
        [int]$Cluster,
        [long]$Size,
        [int]$FatDate
    )
    $entry = New-Object byte[] 32
    [Array]::Copy($ShortName11, 0, $entry, 0, 11)
    $entry[11] = 0x20
    $entry[12] = 0
    $entry[13] = 0
    Set-U16 -Buffer $entry -Offset 14 -Value 0
    Set-U16 -Buffer $entry -Offset 16 -Value $FatDate
    Set-U16 -Buffer $entry -Offset 18 -Value $FatDate
    Set-U16 -Buffer $entry -Offset 20 -Value (($Cluster -shr 16) -band 0xFFFF)
    Set-U16 -Buffer $entry -Offset 22 -Value 0
    Set-U16 -Buffer $entry -Offset 24 -Value $FatDate
    Set-U16 -Buffer $entry -Offset 26 -Value ($Cluster -band 0xFFFF)
    Set-U32 -Buffer $entry -Offset 28 -Value ([uint32]$Size)
    return $entry
}

function Write-CidataImage {
    param(
        [string]$Path,
        [System.Collections.Specialized.OrderedDictionary]$Files,
        [int]$SizeMB = 64
    )

    $sectorSize = 512
    $totalBytes = [long]$SizeMB * 1MB
    if (($totalBytes % $sectorSize) -ne 0) { throw 'cidata image size must be a multiple of 512 bytes.' }
    $totalSectors = [int]($totalBytes / $sectorSize)
    $reservedSectors = 32
    $numFats = 2
    $sectorsPerCluster = 1
    $fatSectors = 1

    for ($i = 0; $i -lt 100; $i++) {
        $dataSectors = $totalSectors - $reservedSectors - ($numFats * $fatSectors)
        $clusters = [math]::Floor($dataSectors / $sectorsPerCluster)
        $neededFatSectors = [int][math]::Ceiling((($clusters + 2) * 4) / $sectorSize)
        if ($neededFatSectors -le $fatSectors) { break }
        $fatSectors = $neededFatSectors
    }

    $dataStart = $reservedSectors + ($numFats * $fatSectors)
    $clusters = [int][math]::Floor(($totalSectors - $dataStart) / $sectorsPerCluster)
    if ($clusters -lt 65525) {
        throw "cidata image is too small for FAT32: $clusters clusters. Use at least 48 MB."
    }

    $image = New-Object byte[] $totalBytes
    $fat = New-Object 'uint32[]' ($clusters + 2)
    $fat[0] = [uint32]0x0FFFFFF8
    $fat[1] = [uint32]0x0FFFFFFF
    $fatDate = (((2026 - 1980) -shl 9) -bor (1 -shl 5) -bor 1)

    $usedNames = @{}
    $entries = New-Object System.Collections.Generic.List[byte[]]
    $shortEntryIndex = @{}

    $label = New-Object byte[] 32
    $labelName = [System.Text.Encoding]::ASCII.GetBytes('CIDATA     ')
    [Array]::Copy($labelName, 0, $label, 0, 11)
    $label[11] = 0x08
    $entries.Add($label)

    foreach ($name in $Files.Keys) {
        $short = Get-ShortName -Name $name -Used $usedNames
        $short11 = Get-ShortNameBytes -ShortName $short
        if ($name -cne $short) {
            $lfnEntries = New-LfnEntries -Name $name -ShortName $short11
            foreach ($lfn in $lfnEntries) {
                $entries.Add($lfn)
            }
        }
        $placeholder = New-ShortEntry -ShortName11 $short11 -Cluster 0 -Size 0 -FatDate $fatDate
        $shortEntryIndex[$name] = $entries.Count
        $entries.Add($placeholder)
    }

    $entriesPerCluster = [int]($sectorsPerCluster * $sectorSize / 32)
    $rootClusterCount = [int][math]::Ceiling($entries.Count / $entriesPerCluster)
    $nextCluster = 2
    $rootStart = $nextCluster
    for ($i = 0; $i -lt $rootClusterCount; $i++) {
        $cluster = $rootStart + $i
        if ($i -eq $rootClusterCount - 1) { $fat[$cluster] = [uint32]0x0FFFFFFF }
        else { $fat[$cluster] = [uint32]($cluster + 1) }
    }
    $nextCluster += $rootClusterCount

    foreach ($name in $Files.Keys) {
        $data = $Files[$name]
        $clusterCount = [int][math]::Ceiling($data.Length / ($sectorsPerCluster * $sectorSize))
        $startCluster = 0
        if ($data.Length -gt 0) {
            $startCluster = $nextCluster
            for ($i = 0; $i -lt $clusterCount; $i++) {
                $cluster = $startCluster + $i
                if ($i -eq $clusterCount - 1) { $fat[$cluster] = [uint32]0x0FFFFFFF }
                else { $fat[$cluster] = [uint32]($cluster + 1) }
            }
            $offset = ($dataStart + (($startCluster - 2) * $sectorsPerCluster)) * $sectorSize
            [Array]::Copy($data, 0, $image, [int]$offset, $data.Length)
            $nextCluster += $clusterCount
        }

        $entry = $entries[$shortEntryIndex[$name]]
        Set-U16 -Buffer $entry -Offset 20 -Value (($startCluster -shr 16) -band 0xFFFF)
        Set-U16 -Buffer $entry -Offset 26 -Value ($startCluster -band 0xFFFF)
        Set-U32 -Buffer $entry -Offset 28 -Value ([uint32]$data.Length)
    }

    # Write the directory entries into their clusters.
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $clusterIndex = [math]::Floor($i / $entriesPerCluster)
        $within = ($i % $entriesPerCluster) * 32
        $cluster = $rootStart + $clusterIndex
        $offset = (($dataStart + (($cluster - 2) * $sectorsPerCluster)) * $sectorSize) + $within
        if ($null -eq $entries[$i] -or $entries[$i].Length -lt 32 -or ($offset + 32) -gt $image.Length) {
            throw "directory entry $i is invalid (length $(if ($null -eq $entries[$i]) { 'null' } else { $entries[$i].Length }), offset $offset, image $($image.Length))"
        }
        [Array]::Copy($entries[$i], 0, $image, [int]$offset, 32)
    }

    # FAT copies.
    $fatBytes = New-Object byte[] ($fatSectors * $sectorSize)
    for ($i = 0; $i -lt $fat.Length; $i++) {
        Set-U32 -Buffer $fatBytes -Offset ($i * 4) -Value $fat[$i]
    }
    [Array]::Copy($fatBytes, 0, $image, ($reservedSectors * $sectorSize), $fatBytes.Length)
    [Array]::Copy($fatBytes, 0, $image, (($reservedSectors + $fatSectors) * $sectorSize), $fatBytes.Length)

    # Boot sector.
    $boot = New-Object byte[] $sectorSize
    $boot[0] = 0xEB
    $boot[1] = 0x58
    $boot[2] = 0x90
    $oem = [System.Text.Encoding]::ASCII.GetBytes('MSWIN4.1')
    [Array]::Copy($oem, 0, $boot, 3, 8)
    Set-U16 -Buffer $boot -Offset 11 -Value $sectorSize
    $boot[13] = [byte]$sectorsPerCluster
    Set-U16 -Buffer $boot -Offset 14 -Value $reservedSectors
    $boot[16] = [byte]$numFats
    Set-U16 -Buffer $boot -Offset 17 -Value 0
    Set-U16 -Buffer $boot -Offset 19 -Value 0
    $boot[21] = 0xF8
    Set-U16 -Buffer $boot -Offset 22 -Value 0
    Set-U16 -Buffer $boot -Offset 24 -Value 32
    Set-U16 -Buffer $boot -Offset 26 -Value 64
    Set-U32 -Buffer $boot -Offset 28 -Value 0
    Set-U32 -Buffer $boot -Offset 32 -Value ([uint32]$totalSectors)
    Set-U32 -Buffer $boot -Offset 36 -Value ([uint32]$fatSectors)
    Set-U16 -Buffer $boot -Offset 40 -Value 0
    Set-U16 -Buffer $boot -Offset 42 -Value 0
    Set-U32 -Buffer $boot -Offset 44 -Value 2
    Set-U16 -Buffer $boot -Offset 48 -Value 1
    Set-U16 -Buffer $boot -Offset 50 -Value 6
    for ($i = 52; $i -lt 64; $i++) { $boot[$i] = 0 }
    $boot[64] = 0x80
    $boot[65] = 0
    $boot[66] = 0x29
    Set-U32 -Buffer $boot -Offset 67 -Value ([uint32]0x48424F54)
    $volLab = [System.Text.Encoding]::ASCII.GetBytes('CIDATA     ')
    [Array]::Copy($volLab, 0, $boot, 71, 11)
    $fsType = [System.Text.Encoding]::ASCII.GetBytes('FAT32   ')
    [Array]::Copy($fsType, 0, $boot, 82, 8)
    $boot[510] = 0x55
    $boot[511] = 0xAA
    [Array]::Copy($boot, 0, $image, 0, $sectorSize)
    [Array]::Copy($boot, 0, $image, (6 * $sectorSize), $sectorSize)

    # FSInfo, primary and backup.
    $freeClusters = $clusters - ($nextCluster - 2)
    $fsInfo = New-Object byte[] $sectorSize
    Set-U32 -Buffer $fsInfo -Offset 0 -Value ([uint32]0x41615252)
    Set-U32 -Buffer $fsInfo -Offset 484 -Value ([uint32]0x61417272)
    Set-U32 -Buffer $fsInfo -Offset 488 -Value ([uint32]$freeClusters)
    Set-U32 -Buffer $fsInfo -Offset 492 -Value ([uint32]$nextCluster)
    Set-U32 -Buffer $fsInfo -Offset 508 -Value ([uint32]2857697280)
    [Array]::Copy($fsInfo, 0, $image, (1 * $sectorSize), $sectorSize)
    [Array]::Copy($fsInfo, 0, $image, (7 * $sectorSize), $sectorSize)

    $stream = [System.IO.File]::Open((ConvertTo-LongPath $Path), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $stream.Write($image, 0, $image.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
}

# ---------------------------------------------------------------- FAT32 reader

function Read-FatChain {
    param([uint32[]]$Fat, [int]$Start, [int]$Limit)
    $result = New-Object System.Collections.Generic.List[int]
    $seen = @{}
    $cluster = $Start
    while ($cluster -ge 2 -and $cluster -lt $Limit -and -not $seen.ContainsKey($cluster)) {
        $seen[$cluster] = $true
        $result.Add($cluster)
        $value = [int]($Fat[$cluster] -band 0x0FFFFFFF)
        if ($value -ge 0x0FFFFFF8) { break }
        $cluster = $value
    }
    return $result.ToArray()
}

function Test-CidataImage {
    param([string]$Path)

    $image = [System.IO.File]::ReadAllBytes((ConvertTo-LongPath $Path))
    if ($image.Length -lt 4MB) { throw 'cidata image is too small.' }
    if ((Get-U16 -Buffer $image -Offset 11) -ne 512) { throw 'cidata boot sector does not use 512-byte sectors.' }
    $sectorsPerCluster = [int]$image[13]
    $reserved = Get-U16 -Buffer $image -Offset 14
    $numFats = [int]$image[16]
    $fatSectors = Get-U32 -Buffer $image -Offset 36
    $rootCluster = Get-U32 -Buffer $image -Offset 44
    $label = [System.Text.Encoding]::ASCII.GetString($image, 71, 11).Trim()
    if ($label -ne 'CIDATA') { throw "cidata volume label is '$label', expected CIDATA." }
    if ($image[510] -ne 0x55 -or $image[511] -ne 0xAA) { throw 'cidata boot sector signature is missing.' }

    $fatOffset = $reserved * 512
    $fat = New-Object 'uint32[]' ([int]($fatSectors * 512 / 4))
    for ($i = 0; $i -lt $fat.Length; $i++) {
        $fat[$i] = Get-U32 -Buffer $image -Offset ($fatOffset + ($i * 4))
    }
    $dataStart = $reserved + ($numFats * $fatSectors)
    $clusterSize = $sectorsPerCluster * 512
    $clusterLimit = [int][math]::Floor(($image.Length - ($dataStart * 512)) / $clusterSize) + 2

    $files = @{}
    $rootChain = Read-FatChain -Fat $fat -Start $rootCluster -Limit $clusterLimit
    $lfn = @{}
    $done = $false
    foreach ($cluster in $rootChain) {
        if ($done) { break }
        $clusterOffset = ($dataStart + (($cluster - 2) * $sectorsPerCluster)) * 512
        for ($entryOffset = 0; $entryOffset -lt $clusterSize; $entryOffset += 32) {
            $offset = $clusterOffset + $entryOffset
            if ($image[$offset] -eq 0) { $done = $true; break }
            $attr = $image[$offset + 11]
            if ($attr -eq 0x0F) {
                $order = [int]$image[$offset] -band 0x3F
                $chars = New-Object System.Collections.Generic.List[char]
                $positions = @(1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30)
                foreach ($position in $positions) {
                    $unit = Get-U16 -Buffer $image -Offset ($offset + $position)
                    if ($unit -eq 0x0000 -or $unit -eq 0xFFFF) { continue }
                    $chars.Add([char]$unit)
                }
                $lfn[$order] = -join $chars
                continue
            }
            if ($attr -eq 0x08) { continue }
            if (($attr -band 0x10) -ne 0) { continue }
            if ($attr -ne 0x20) { continue }

            $shortName = [System.Text.Encoding]::ASCII.GetString($image, $offset, 11)
            if ($lfn.Count -gt 0) {
                $name = ''
                foreach ($key in ($lfn.Keys | Sort-Object)) { $name += $lfn[$key] }
                $lfn = @{}
            }
            else {
                $base = $shortName.Substring(0, 8).Trim()
                $ext = $shortName.Substring(8, 3).Trim()
                if ([string]::IsNullOrWhiteSpace($ext)) { $name = $base }
                else { $name = $base + '.' + $ext }
            }

            $high = Get-U16 -Buffer $image -Offset ($offset + 20)
            $low = Get-U16 -Buffer $image -Offset ($offset + 26)
            $start = ($high -shl 16) -bor $low
            $size = [int](Get-U32 -Buffer $image -Offset ($offset + 28))
            $bytes = New-Object byte[] $size
            if ($size -gt 0) {
                $chain = Read-FatChain -Fat $fat -Start $start -Limit $clusterLimit
                $written = 0
                foreach ($fileCluster in $chain) {
                    $fileOffset = ($dataStart + (($fileCluster - 2) * $sectorsPerCluster)) * 512
                    $take = [math]::Min($clusterSize, $size - $written)
                    [Array]::Copy($image, $fileOffset, $bytes, $written, $take)
                    $written += $take
                    if ($written -ge $size) { break }
                }
                if ($written -ne $size) { throw "cidata file $name is truncated." }
            }
            $files[$name] = $bytes
        }
    }

    return [pscustomobject]@{
        VolumeLabel = $label
        Files       = $files
    }
}

# ---------------------------------------------------------------- ISO / disks

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
        $target = [System.IO.File]::Open("\\.\PhysicalDrive$PhysicalDiskNumber", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
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
    param([string]$RequestedCidataImage)

    $root = Join-Path $env:TEMP ('make-installer-selftest-' + [guid]::NewGuid().ToString('N'))
    $cidataPath = $RequestedCidataImage
    $keepCidata = -not [string]::IsNullOrWhiteSpace($cidataPath)
    if (-not $keepCidata) { $cidataPath = Join-Path $root 'cidata.img' }

    try {
        Write-Step 'make-installer self-test'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        if ($keepCidata) {
            $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($cidataPath))
            if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        }

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

        # 2. Password hash via openssl stdin (never argv).
        $openssl = Find-OpenSsl
        $secure = New-SecureStringFromPlain $script:SelfTestPassword
        $hash = Get-CryptHash -Secure $secure -OpenSsl $openssl
        if ($hash -notmatch '^\$6\$') { throw 'password hash is not SHA-512 crypt' }
        Write-Host 'PASS SHA-512 crypt hash from stdin'

        # 3. cidata payload and FAT32 image.
        $keysPath = Join-Path $root 'authorized_keys'
        Set-Content -LiteralPath $keysPath -Value 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISELFTESTKEYONLY000000000000000000000000 selftest@example' -Encoding ASCII
        $keys = Read-AuthorizedKeys -Path $keysPath
        $payload = New-CidataPayload -User 'harout' -Machine 'hbots' -Zone 'Europe/London' -Layout 'gb' -Device '/dev/nvme0n1' -Bytes 512110190592 -PasswordHash $hash -AuthorizedKeys $keys
        if ($payload.Count -ne 5) { throw "expected 5 cidata files, got $($payload.Count)" }
        Write-CidataImage -Path $cidataPath -Files $payload -SizeMB $CidataSizeMB
        $parsed = Test-CidataImage -Path $cidataPath
        if ($parsed.VolumeLabel -ne 'CIDATA') { throw 'cidata label did not round-trip' }
        foreach ($name in @('user_configuration.json', 'user_credentials.json', 'user_encrypt_installation.txt', 'authorized_keys', 'hostname')) {
            if (-not $parsed.Files.ContainsKey($name)) { throw "cidata image is missing $name" }
        }
        $config = [System.Text.Encoding]::UTF8.GetString($parsed.Files['user_configuration.json']) | ConvertFrom-Json
        if ($config.hostname -ne 'hbots') { throw 'user_configuration hostname did not round-trip' }
        if ($config.disk_config.device_modifications[0].device -ne '/dev/nvme0n1') { throw 'disk device did not round-trip' }
        if ($config.omarchy_install.mode -ne 'full_disk') { throw 'omarchy_install.mode did not round-trip' }
        $creds = [System.Text.Encoding]::UTF8.GetString($parsed.Files['user_credentials.json']) | ConvertFrom-Json
        if ($creds.users[0].enc_password -notmatch '^\$6\$') { throw 'credentials do not carry a SHA-512 crypt hash' }
        if ($creds.users[0].username -ne 'harout') { throw 'username did not round-trip' }
        Write-Host 'PASS cidata FAT32 image and JSON schema'

        $all = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($cidataPath))
        if ($all.Contains($script:SelfTestPassword)) { throw 'the plaintext test password appears in the cidata image' }
        Write-Host 'PASS no plaintext password in the cidata image'

        # 4. Raw image writer to a plain file.
        $rawTarget = Join-Path $root 'raw-write.bin'
        Write-RawImage -ImagePath $cidataPath -TargetFile $rawTarget
        if ((Get-Sha256 -Path $rawTarget) -ne (Get-Sha256 -Path $cidataPath)) { throw 'raw image write did not round-trip' }
        Write-Host 'PASS buffered image write and flush'

        # 5. Disk guards with synthetic disks.
        $system = [pscustomobject]@{ Number = 0; FriendlyName = 'System Disk'; Size = 512GB; BusType = 'NVMe'; IsSystem = $true; IsBoot = $true }
        $fixed = [pscustomobject]@{ Number = 1; FriendlyName = 'Fixed Disk'; Size = 512GB; BusType = 'NVMe'; IsSystem = $false; IsBoot = $false }
        $removable = [pscustomobject]@{ Number = 2; FriendlyName = 'USB Test'; Size = 32GB; BusType = 'USB'; IsSystem = $false; IsBoot = $false }
        $rejected = $false
        try { Assert-DiskSafe -Disk $system -Purpose 'test' -RepoRoot '' } catch { $rejected = $true }
        if (-not $rejected) { throw 'system disk was accepted' }
        $rejected = $false
        try { Assert-DiskSafe -Disk $fixed -Purpose 'test' -RepoRoot '' } catch { $rejected = $true }
        if (-not $rejected) { throw 'fixed disk was accepted without -AllowFixed' }
        Assert-DiskSafe -Disk $removable -Purpose 'test' -RepoRoot '' -AllowFixedDisk
        Write-Host 'PASS disk guards'

        # 6. Confirmation.
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
    exit (Invoke-SelfTest -RequestedCidataImage $ImageFile)
}

if ($BuildCidataOnly -and $IsoDiskNumber -ge 0) {
    throw '-BuildCidataOnly does not take -IsoDiskNumber.'
}

try {
    if ($BuildCidataOnly) {
        Write-Step 'cidata only'
        if ([string]::IsNullOrWhiteSpace($ImageFile) -and $CidataDiskNumber -lt 0) {
            throw 'Pass -ImageFile <path> (test/file mode) or -CidataDiskNumber <n>.'
        }
        if (-not $Apply) {
            Write-Step 'cidata only (dry run)'
            if (-not [string]::IsNullOrWhiteSpace($ImageFile)) {
                Write-Info "image file: $ImageFile"
            }
            if ($CidataDiskNumber -ge 0) {
                $disk = Get-Disk -Number $CidataDiskNumber -ErrorAction Stop
                Assert-DiskSafe -Disk $disk -Purpose 'cidata stick' -RepoRoot (Get-Location).Path -AllowFixedDisk:$AllowFixed
                Write-Info "disk: $($disk.Number) $($disk.FriendlyName) ($([math]::Round($disk.Size / 1GB, 1)) GB)"
            }
            Write-Info "user: $Username  hostname: $Hostname  timezone: $Timezone  keyboard: $Keyboard"
            Write-Info "disk: $DiskDevice  bytes: $DiskBytes"
            Write-Info "authorized keys: $AuthorizedKeysPath"
            Write-Info 'the password would be typed locally; only its SHA-512 crypt hash would be written'
            Write-Host '    Nothing was prompted, written or erased.' -ForegroundColor Green
            exit 0
        }

        $keys = Read-AuthorizedKeys -Path $AuthorizedKeysPath
        $password = Read-OperatorPassword -User $Username
        $hash = Get-CryptHash -Secure $password -OpenSsl (Find-OpenSsl)
        $payload = New-CidataPayload -User $Username -Machine $Hostname -Zone $Timezone -Layout $Keyboard -Device $DiskDevice -Bytes $DiskBytes -PasswordHash $hash -AuthorizedKeys $keys

        $staging = $ImageFile
        $temporary = $false
        if ([string]::IsNullOrWhiteSpace($staging)) {
            $staging = Join-Path $env:TEMP ('cidata-' + [guid]::NewGuid().ToString('N') + '.img')
            $temporary = $true
        }
        Write-CidataImage -Path $staging -Files $payload -SizeMB $CidataSizeMB
        $check = Test-CidataImage -Path $staging
        Write-Info "built $($check.Files.Count) files in $staging"

        if ($CidataDiskNumber -ge 0) {
            if (-not $Apply) { throw 'Writing to a physical disk needs -Apply.' }
            $disk = Get-Disk -Number $CidataDiskNumber -ErrorAction Stop
            Assert-DiskSafe -Disk $disk -Purpose 'cidata stick' -RepoRoot (Get-Location).Path -AllowFixedDisk:$AllowFixed
            if ($disk.Size -lt (64MB)) { throw "Disk $CidataDiskNumber is smaller than 64 MB." }
            Resolve-DiskConfirmation -Disk $disk -Supplied $ConfirmText
            Clear-TargetDisk -Disk $disk -Erase:$EraseDisk
            Write-RawImage -ImagePath $staging -PhysicalDiskNumber $CidataDiskNumber -ApplyImage
        }
        if ($temporary -and (Test-Path -LiteralPath $staging)) {
            Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
        }
        Write-Host 'cidata ready.' -ForegroundColor Green
        exit 0
    }

    Write-Step 'Omarchy installer'
    $iso = Resolve-OmarchyIso -RequestedVersion $Version -Path $IsoPath -DownloadUrl $IsoUrl -ChecksumAddress $ChecksumUrl -Download:$false
    $report = Get-DiskReport
    $isoDisk = $null

    if ($IsoDiskNumber -ge 0) {
        $isoDisk = Get-Disk -Number $IsoDiskNumber -ErrorAction Stop
        Assert-DiskSafe -Disk $isoDisk -Purpose 'ISO stick' -RepoRoot (Get-Location).Path -AllowFixedDisk:$AllowFixed
        Write-Info "ISO stick:   $($isoDisk.Number) $($isoDisk.FriendlyName) ($([math]::Round($isoDisk.Size / 1GB, 1)) GB)"
        if ([string]::IsNullOrWhiteSpace($CidataImage) -and $CidataDiskNumber -lt 0) {
            throw 'A second stick is required for cidata. Pass -CidataDiskNumber <n> or -CidataImage <path>.'
        }
        if ($CidataDiskNumber -ge 0) {
            $cidataDisk = Get-Disk -Number $CidataDiskNumber -ErrorAction Stop
            Assert-DiskSafe -Disk $cidataDisk -Purpose 'cidata stick' -RepoRoot (Get-Location).Path -AllowFixedDisk:$AllowFixed
            if ($cidataDisk.Number -eq $isoDisk.Number) {
                throw 'The ISO and cidata must be on two different sticks. One stick does not work with this flow.'
            }
            Write-Info "cidata stick: $($cidataDisk.Number) $($cidataDisk.FriendlyName) ($([math]::Round($cidataDisk.Size / 1GB, 1)) GB)"
        }
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
        Write-Info 'cidata would be built with the operator-typed password and written to the second stick'
        Write-Host '    Nothing was downloaded, written or erased.' -ForegroundColor Green
        exit 0
    }

    if ($IsoDiskNumber -lt 0 -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        throw 'Apply needs -IsoDiskNumber (or -ImageFile for a file test).'
    }
    if (-not [string]::IsNullOrWhiteSpace($ImageFile) -and [string]::IsNullOrWhiteSpace($CidataImage) -and $CidataDiskNumber -lt 0) {
        $CidataImage = $ImageFile + '.cidata.img'
        Write-Info "test mode: cidata will be written to $CidataImage"
    }
    if ([string]::IsNullOrWhiteSpace($CidataImage) -and $CidataDiskNumber -lt 0) {
        throw 'Apply needs -CidataDiskNumber <n> (second stick) or -CidataImage <path> for a file.'
    }

    if ($null -ne $isoDisk -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        Resolve-DiskConfirmation -Disk $isoDisk -Supplied $ConfirmText
        Clear-TargetDisk -Disk $isoDisk -Erase:$EraseDisk
    }

    if ([string]::IsNullOrWhiteSpace($CidataImage)) {
        $cidataDisk = Get-Disk -Number $CidataDiskNumber -ErrorAction Stop
        Resolve-DiskConfirmation -Disk $cidataDisk -Supplied $ConfirmText
    }

    if (-not (Test-Path -LiteralPath $iso.Path)) {
        Write-Step 'Downloading ISO'
        $iso = Resolve-OmarchyIso -RequestedVersion $Version -Path $iso.Path -DownloadUrl $iso.Url -ChecksumAddress $ChecksumUrl -Download
    }

    if ($null -ne $isoDisk -and [string]::IsNullOrWhiteSpace($ImageFile)) {
        $isoFileSize = (Get-Item -LiteralPath $iso.Path).Length
        if ($isoFileSize -gt $isoDisk.Size) { throw "The ISO ($isoFileSize bytes) does not fit on disk $IsoDiskNumber ($($isoDisk.Size) bytes)." }
    }

    Write-Step 'Writing ISO'
    if ([string]::IsNullOrWhiteSpace($ImageFile)) {
        Write-RawImage -ImagePath $iso.Path -PhysicalDiskNumber $IsoDiskNumber -ApplyImage
    }
    else {
        Write-Info "test mode: ISO -> $ImageFile"
        Write-RawImage -ImagePath $iso.Path -TargetFile $ImageFile
    }

    Write-Step 'Writing cidata'
    $keys = Read-AuthorizedKeys -Path $AuthorizedKeysPath
    $password = Read-OperatorPassword -User $Username
    $hash = Get-CryptHash -Secure $password -OpenSsl (Find-OpenSsl)
    $payload = New-CidataPayload -User $Username -Machine $Hostname -Zone $Timezone -Layout $Keyboard -Device $DiskDevice -Bytes $DiskBytes -PasswordHash $hash -AuthorizedKeys $keys
    $cidataTemp = Join-Path $env:TEMP ('cidata-' + [guid]::NewGuid().ToString('N') + '.img')
    try {
        Write-CidataImage -Path $cidataTemp -Files $payload -SizeMB $CidataSizeMB
        $null = Test-CidataImage -Path $cidataTemp
        if (-not [string]::IsNullOrWhiteSpace($CidataImage)) {
            $cidataParent = Split-Path -Parent ([System.IO.Path]::GetFullPath($CidataImage))
            if (-not [string]::IsNullOrWhiteSpace($cidataParent)) {
                New-Item -ItemType Directory -Path $cidataParent -Force | Out-Null
            }
            Copy-Item -LiteralPath $cidataTemp -Destination $CidataImage -Force
            Write-Info "test mode: cidata -> $CidataImage"
        }
        else {
            $cidataDisk = Get-Disk -Number $CidataDiskNumber -ErrorAction Stop
            if ($cidataDisk.Size -lt (64MB)) { throw "Disk $CidataDiskNumber is smaller than 64 MB." }
            Clear-TargetDisk -Disk $cidataDisk -Erase:$EraseDisk
            Write-RawImage -ImagePath $cidataTemp -PhysicalDiskNumber $CidataDiskNumber -ApplyImage
        }
    }
    finally {
        if (Test-Path -LiteralPath $cidataTemp) { Remove-Item -LiteralPath $cidataTemp -Force -ErrorAction SilentlyContinue }
    }

    Write-Step 'Done'
    Write-Host 'Stick 1: Omarchy ISO. Stick 2: CIDATA. Use two sticks.' -ForegroundColor Green
    Write-Host 'Next: F2 Secure Boot off, F12 boot the ISO stick, leave the cidata stick plugged in.' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
