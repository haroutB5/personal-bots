<#
.SYNOPSIS
Live smoke test of the running Personal Bots server after a deploy or rollback.

.DESCRIPTION
Read-only. Checks, in order:
1. The recorded server process is alive and serves -ExpectRelease.
2. The local /.well-known/t3/environment answers 200.
3. The T3 Connect endpoint (from `connect status --json`) answers 200 on the
   same path through the relay. That path needs no session (verified
   2026-09-15), so it proves the tunnel end to end.
4. Stability window: for -StableSeconds the pid and startedAt stay the same
   (no crash-loop restart by the supervisor), then the local check passes again.
5. The server log written since -LogFromByte (default: its last 300 lines)
   has no migration or SQL errors.
Exit 0 when all pass, 1 otherwise. Used by upstream-sync.ps1 after restart.ps1.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\smoke.ps1 -ExpectRelease <sha>
#>
[CmdletBinding()]
param(
    [string]$ExpectRelease,
    [int]$StartTimeoutSeconds = 90,
    [int]$TunnelTimeoutSeconds = 90,
    [int]$StableSeconds = 120,
    [long]$LogFromByte = -1,
    [string]$LogFile,
    [switch]$NoTunnel,
    [string]$Node
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
$failures = New-Object System.Collections.Generic.List[string]
function Pass([string]$Text) { Write-Host "  ok    $Text" }
function Fail([string]$Text) { Write-Host "  FAIL  $Text"; $failures.Add($Text) | Out-Null }

function Test-Http200([string]$Uri, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $Uri
            if ($response.StatusCode -eq 200) { return $response }
        } catch { }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
    return $null
}

Write-Host 'Personal Bots smoke'

# 1. Process + release
$state = $null
$deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
do {
    $candidate = Read-PbServerState -Paths $paths
    if ($candidate -and (Test-PbServerProcess -ProcessId ([int]$candidate.pid) -BinPath $candidate.binPath -BaseDir $candidate.baseDir) -and
        (-not $ExpectRelease -or [string]$candidate.release -eq $ExpectRelease)) {
        $state = $candidate
        break
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if (-not $state) {
    $seen = Read-PbServerState -Paths $paths
    $seenRelease = if ($seen) { [string]$seen.release } else { 'none' }
    Fail "server process serving release '$ExpectRelease' not found within $StartTimeoutSeconds s (recorded: $seenRelease)"
    Write-Host "Smoke FAILED ($($failures.Count) problem(s))."
    exit 1
}
Pass "process pid $($state.pid), release $($state.release), started $($state.startedAt)"

# 2. Local health
$runtime = $null
$deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
do {
    $runtime = Read-PbRuntimeState -BaseDir ([string]$state.baseDir)
    if ($runtime -and $runtime.origin) { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
$localUri = $null
if (-not $runtime -or -not $runtime.origin) {
    Fail 'no server-runtime.json origin'
} else {
    $localUri = ([string]$runtime.origin).TrimEnd('/') + '/.well-known/t3/environment'
    $local = Test-Http200 -Uri $localUri -TimeoutSeconds $StartTimeoutSeconds
    if ($local) {
        $descriptor = $local.Content | ConvertFrom-Json
        Pass "local $localUri (t3 $($descriptor.serverVersion))"
    } else {
        Fail "local $localUri did not answer 200"
    }
}

# 3. Tunnel health
if (-not $NoTunnel) {
    $nodeExe = Resolve-NodeExe -Node $Node
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = (& $nodeExe ([string]$state.binPath) connect status --json --base-dir ([string]$state.baseDir) 2>$null) -join "`n"
    $ErrorActionPreference = $previous
    $connect = $null
    $jsonStart = $raw.IndexOf('{')
    if ($jsonStart -ge 0) { try { $connect = $raw.Substring($jsonStart) | ConvertFrom-Json } catch { $connect = $null } }
    $endpoint = $null
    if ($connect -and ($connect.PSObject.Properties.Name -contains 'endpointUrl')) { $endpoint = [string]$connect.endpointUrl }
    if (-not $endpoint) {
        Fail 'connect status --json has no endpointUrl'
    } else {
        $tunnelUri = $endpoint.TrimEnd('/') + '/.well-known/t3/environment'
        if (Test-Http200 -Uri $tunnelUri -TimeoutSeconds $TunnelTimeoutSeconds) {
            Pass "tunnel $tunnelUri (linked $($connect.linked))"
        } else {
            Fail "tunnel $tunnelUri did not answer 200 within $TunnelTimeoutSeconds s (linked $($connect.linked), desired $($connect.desired))"
        }
    }
}

# 4. Stability window
$deadline = (Get-Date).AddSeconds($StableSeconds)
$stable = $true
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $now = Read-PbServerState -Paths $paths
    if (-not $now -or [string]$now.pid -ne [string]$state.pid -or [string]$now.startedAt -ne [string]$state.startedAt -or
        -not (Test-PbServerProcess -ProcessId ([int]$now.pid) -BinPath $now.binPath -BaseDir $now.baseDir)) {
        $stable = $false
        break
    }
}
if ($stable -and $localUri -and (Test-Http200 -Uri $localUri -TimeoutSeconds 20)) {
    Pass "stable for $StableSeconds s (same pid and start time)"
} else {
    Fail "server restarted or stopped answering within the $StableSeconds s stability window"
}

# 5. Log scan
if (-not $LogFile) {
    $latest = Get-ChildItem -LiteralPath $paths.LogsDir -Filter 'server-*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) { $LogFile = $latest.FullName }
}
if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
    if ($LogFromByte -ge 0) {
        $stream = [System.IO.File]::Open($LogFile, 'Open', 'Read', 'ReadWrite')
        try {
            $null = $stream.Seek([math]::Min($LogFromByte, $stream.Length), 'Begin')
            $reader = New-Object System.IO.StreamReader($stream)
            $lines = $reader.ReadToEnd() -split "`n"
        } finally { $stream.Dispose() }
    } else {
        $lines = Get-Content -LiteralPath $LogFile -Tail 300
    }
    $pattern = 'MigrationError|Migrations? failed|SqlError|no such column|no such table|SQLITE_ERROR|Defect in|FATAL'
    $bad = @($lines | Where-Object { $_ -match $pattern })
    if ($bad.Count -eq 0) {
        Pass "log $LogFile has no migration/SQL errors"
    } else {
        Fail "log $LogFile has $($bad.Count) migration/SQL error line(s): $(($bad | Select-Object -First 3) -join ' | ')"
    }
} else {
    Fail 'no server log found'
}

if ($failures.Count -eq 0) {
    Write-Host 'Smoke PASSED.'
    exit 0
}
Write-Host "Smoke FAILED ($($failures.Count) problem(s))."
exit 1
