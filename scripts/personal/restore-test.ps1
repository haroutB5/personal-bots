<#
.SYNOPSIS
Proves the latest backup restores: copies it into a throwaway temp data root,
serves it on a random loopback port, and checks /.well-known/t3/environment.

.DESCRIPTION
The throwaway server gets no secrets (backups carry none), so it cannot link
T3 Connect or touch the real environment. The copy still holds the real
routines, queued tasks and provider CLIs (settings.json), so the server runs
with T3CODE_PERSONAL_SCHEDULERS=off: no routine fires and no task starts.
Builds before that switch ignore it (the line after PASSED says which). It is stopped by its captured PID
after the check, and only its own temp directory (%TEMP%\pb-restore-test-*) is
deleted. The run log is kept in %USERPROFILE%\.personal-bots\logs.

It doubles as the pre-deploy migration rehearsal: serve a NEW build against a
copy of the newest backup (never the live database), then assert the migrator
reached -ExpectMigration and that -ExpectColumn columns exist in the copy.
-Release serves a staged release; -BinPath serves any built bin.mjs (for
example a checkout's apps\server\dist\bin.mjs, so nothing is staged).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restore-test.ps1

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\restore-test.ps1 -Release <sha> -ExpectMigration 67 -ExpectColumn projection_threads.title_state_json
#>
[CmdletBinding()]
param(
    [string]$Backup,
    [string]$Release,
    [string]$BinPath,
    [string]$Node,
    [int]$Seconds = 120,
    [int]$ExpectMigration = 0,
    [string[]]$ExpectColumn = @()
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

# Not $release: that is the [string]$Release parameter (names are case-insensitive).
if ($BinPath) {
    if (-not (Test-Path -LiteralPath $BinPath -PathType Leaf)) { throw "No bin.mjs at $BinPath." }
    $releaseInfo = [pscustomobject]@{ Name = $BinPath; Bin = (Resolve-Path -LiteralPath $BinPath).Path }
} else {
    $releaseInfo = Get-PbRelease -Paths $paths -Release $Release
}
$nodeExe = Resolve-NodeExe -Node $Node

$tempBase = [System.IO.Path]::GetTempPath()
$tempRoot = Join-Path $tempBase ('pb-restore-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stateDir = Join-Path $tempRoot 'userdata'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# The ~2.5 GB copy runs at background priority: QA 1.66.33 measured the plain
# Copy-Item stalling the LIVE server twice (1,358 ms and 2,224 ms synchronous
# SQLite writes at 19:39:00 and 19:40:23 on 12 Oct). CPU BelowNormal and I/O +
# memory Very Low is the same treatment the release runner gives its backups.
function Set-BackgroundIoPriority {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if (-not ('PbRestoreProc' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PbRestoreProc {
    [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    const uint SET_INFO = 0x0200;
    const int ProcessIoPriority = 33, ProcessPagePriority = 39;
    public static int SetIo(int pid, int level) { return Set(pid, ProcessIoPriority, level); }
    public static int SetMem(int pid, int level) { return Set(pid, ProcessPagePriority, level); }
    static int Set(int pid, int cls, int value) {
        IntPtr h = OpenProcess(SET_INFO, false, pid);
        if (h == IntPtr.Zero) return -1;
        try { return NtSetInformationProcess(h, cls, ref value, 4); } finally { CloseHandle(h); }
    }
}
'@
    }
    $io = [PbRestoreProc]::SetIo($ProcessId, 0)  # 0 = very low
    $mem = [PbRestoreProc]::SetMem($ProcessId, 1) # 1 = very low
    return "io=$io mem=$mem"
}

function Copy-BackupAtLowPriority {
    param([string]$From, [string]$To)
    $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
    if (-not (Test-Path -LiteralPath $robocopy -PathType Leaf)) { return $false }
    $args = @('"' + $From + '"', '"' + $To + '"', '/E', '/XF', 'backup.json', '/R:2', '/W:1',
        '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    $copy = Start-Process -FilePath $robocopy -ArgumentList ($args -join ' ') -PassThru -WindowStyle Hidden
    if ($null -eq $copy) { return $false }
    try { $copy.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }
    $priority = Set-BackgroundIoPriority -ProcessId $copy.Id
    $null = $copy.Handle
    $copy.WaitForExit()
    # Robocopy codes 0-7 are success (files copied, extras present, and so on); 8+ is a failure.
    if ($copy.ExitCode -ge 8) {
        Write-Warning "robocopy exited $($copy.ExitCode); falling back to a normal-priority Copy-Item."
        return $false
    }
    Write-Host "  restored backup at background priority ($priority, robocopy exit $($copy.ExitCode))"
    return $true
}

if (-not (Copy-BackupAtLowPriority -From $backupDir -To $stateDir)) {
    Get-ChildItem -LiteralPath $backupDir | Where-Object { $_.Name -ne 'backup.json' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stateDir $_.Name) -Recurse -Force
    }
}

Clear-DevOriginEnv
$env:T3CODE_ENVIRONMENT_LABEL = 'Bots restore test'
# Routines and the task queue stay off on the restored copy (QA saw one queue 2 real routine runs in 8 s).
$env:T3CODE_PERSONAL_SCHEDULERS = 'off'
$port = Get-FreeTcpPort
$logFile = Join-Path $tempRoot 'restore-test.log'
Write-Host "Restoring $backupDir into $tempRoot and serving on 127.0.0.1:$port ..."

$proc = $null
$ok = $false
$descriptor = $null
$migration = $null
$migrationOk = $true
$migrationProblems = @()
try {
    $proc = Start-PbServeProcess -NodeExe $nodeExe -BinPath $releaseInfo.Bin -BaseDir $tempRoot `
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
    # Migration rehearsal: read the copy the throwaway server just migrated.
    if ($ok -and ($ExpectMigration -gt 0 -or $ExpectColumn.Count -gt 0)) {
        $env:PB_CHECK_DB = Join-Path $stateDir 'state.sqlite'
        $env:PB_CHECK_COLUMNS = ($ExpectColumn -join ',')
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $checkRaw = (& $nodeExe --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'migration-check.cjs')) -join "`n"
        $checkCode = $LASTEXITCODE
        $ErrorActionPreference = $previous
        if ($checkCode -ne 0) {
            $migrationOk = $false
            $migrationProblems += "migration-check.cjs exited $checkCode"
        } else {
            $migration = $checkRaw | ConvertFrom-Json
            if ($ExpectMigration -gt 0 -and [int]$migration.maxMigration -ne $ExpectMigration) {
                $migrationOk = $false
                $migrationProblems += "max migration is $($migration.maxMigration), expected $ExpectMigration"
            }
            foreach ($column in $ExpectColumn) {
                if (-not $migration.columns.$column) {
                    $migrationOk = $false
                    $migrationProblems += "column $column is missing"
                }
            }
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

if ($ok -and -not $migrationOk) {
    Write-Host ("Restore test FAILED: the server answered, but the migrated copy is wrong: {0}. Log: {1}" -f `
            ($migrationProblems -join '; '), $keptLog)
    exit 1
}
if ($ok) {
    Write-Host ("Restore test PASSED: {0} served environment '{1}' (t3 {2}) on port {3}." -f `
            (Split-Path -Leaf $backupDir), $descriptor.label, $descriptor.serverVersion, $port)
    $schedulersConfirmed = (Test-Path -LiteralPath $keptLog) -and
        [bool](Select-String -LiteralPath $keptLog -SimpleMatch -Pattern 'Personal schedulers are OFF' -Quiet)
    Write-Host ("  Schedulers: {0}" -f $(if ($schedulersConfirmed) { 'off (the server logged it)' } else { 'switch set, not confirmed by this build (older builds ignore it)' }))
    if ($migration) {
        $columnText = @($ExpectColumn | ForEach-Object { "$_=$($migration.columns.$_)" }) -join ', '
        Write-Host ("  Migration rehearsal: max migration {0}{1}." -f $migration.maxMigration, $(if ($columnText) { "; $columnText" } else { '' }))
    }
    exit 0
}
Write-Host "Restore test FAILED: no 200 from /.well-known/t3/environment within $Seconds s. Log: $keptLog"
if (Test-Path -LiteralPath $keptLog) { Get-Content -LiteralPath $keptLog -Tail 20 | ForEach-Object { Write-Host "  $_" } }
exit 1
