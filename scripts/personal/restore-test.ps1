<#
.SYNOPSIS
Proves the latest backup restores: copies it into a throwaway temp data root,
serves it on a random loopback port, and checks /.well-known/t3/environment.

.DESCRIPTION
The throwaway server gets no secrets (backups carry none), so it cannot link
T3 Connect or touch the real environment. It is stopped by its captured PID
after the check, and only its own temp directory (%TEMP%\pb-restore-test-*) is
deleted. The run log is kept in %USERPROFILE%\.personal-bots\logs.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restore-test.ps1
#>
[CmdletBinding()]
param(
    [string]$Backup,
    [string]$Release,
    [string]$Node,
    [int]$Seconds = 20
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
if ($Backup) {
    $backupDir = $Backup
    if (-not [System.IO.Path]::IsPathRooted($backupDir)) { $backupDir = Join-Path $paths.BackupsDir $Backup }
} else {
    $latest = Get-ChildItem -LiteralPath $paths.BackupsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name -Descending | Select-Object -First 1
    if ($null -eq $latest) { throw "No backups in $($paths.BackupsDir). Run backup.ps1 first." }
    $backupDir = $latest.FullName
}
if (-not (Test-Path -LiteralPath (Join-Path $backupDir 'state.sqlite') -PathType Leaf)) {
    throw "$backupDir has no state.sqlite."
}

$release = Get-PbRelease -Paths $paths -Release $Release
$nodeExe = Resolve-NodeExe -Node $Node

$tempBase = [System.IO.Path]::GetTempPath()
$tempRoot = Join-Path $tempBase ('pb-restore-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stateDir = Join-Path $tempRoot 'userdata'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Get-ChildItem -LiteralPath $backupDir | Where-Object { $_.Name -ne 'backup.json' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stateDir $_.Name) -Recurse -Force
}

Clear-DevOriginEnv
$env:T3CODE_ENVIRONMENT_LABEL = 'Bots restore test'
$port = Get-FreeTcpPort
$logFile = Join-Path $tempRoot 'restore-test.log'
Write-Host "Restoring $backupDir into $tempRoot and serving on 127.0.0.1:$port ..."

$proc = $null
$ok = $false
$descriptor = $null
try {
    $proc = Start-PbServeProcess -NodeExe $nodeExe -BinPath $release.Bin -BaseDir $tempRoot `
        -LogFile $logFile -WorkingDirectory $tempRoot -Port $port -HostName '127.0.0.1'
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/.well-known/t3/environment"
            if ($response.StatusCode -eq 200) {
                $ok = $true
                $descriptor = $response.Content | ConvertFrom-Json
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
} finally {
    if ($proc -and -not $proc.HasExited) {
        if (-not (Stop-PbProcessTree -ProcessId $proc.Id)) {
            Write-Warning "Throwaway server pid $($proc.Id) did not exit; temp root left at $tempRoot."
        }
    }
    New-Item -ItemType Directory -Force -Path $paths.LogsDir | Out-Null
    $keptLog = Join-Path $paths.LogsDir ('restore-test-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    if (Test-Path -LiteralPath $logFile) { Copy-Item -LiteralPath $logFile -Destination $keptLog -Force }
    Remove-PbOldFiles -Directory $paths.LogsDir -Filter 'restore-test-*.log' -Keep 7

    $leaf = Split-Path -Leaf $tempRoot
    $insideTemp = $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)
    if ($insideTemp -and $leaf -like 'pb-restore-test-*' -and -not ($proc -and -not $proc.HasExited)) {
        for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $tempRoot); $attempt++) {
            try { Remove-Item -LiteralPath $tempRoot -Recurse -Force } catch { Start-Sleep -Milliseconds 500 }
        }
        if (Test-Path -LiteralPath $tempRoot) { Write-Warning "Could not delete $tempRoot; remove it by hand." }
    }
}

if ($ok) {
    Write-Host ("Restore test PASSED: {0} served environment '{1}' (t3 {2}) on port {3}." -f `
            (Split-Path -Leaf $backupDir), $descriptor.label, $descriptor.serverVersion, $port)
    exit 0
}
Write-Host "Restore test FAILED: no 200 from /.well-known/t3/environment within $Seconds s. Log: $keptLog"
if (Test-Path -LiteralPath $keptLog) { Get-Content -LiteralPath $keptLog -Tail 20 | ForEach-Object { Write-Host "  $_" } }
exit 1
