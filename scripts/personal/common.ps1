# Shared helpers for the Personal Bots launcher scripts. Dot-source only:
#   . (Join-Path $PSScriptRoot 'common.ps1')
# Windows PowerShell 5.1 compatible (no ??, no ternary, no && chains).
# Helpers signal failure with throw, never exit: exit inside a dot-sourced
# function does not stop the calling script.

$ErrorActionPreference = 'Stop'

$PbScriptsDir = $PSScriptRoot
$PbRepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'background-priority.ps1')
$PbHome = Join-Path $env:USERPROFILE '.personal-bots'
$PbTaskName = 'Personal Bots'

function Get-PbPaths {
    param([Parameter(Mandatory = $true)][ValidateSet('dev', 'prod')][string]$Root)
    $baseDir = Join-Path $PbHome $Root
    $runDir = Join-Path $PbHome 'run'
    $releasesDir = Join-Path $PbHome 'releases'
    return [pscustomobject]@{
        Root        = $Root
        Home        = $PbHome
        BaseDir     = $baseDir
        StateDir    = Join-Path $baseDir 'userdata'
        LogsDir     = Join-Path $PbHome 'logs'
        RunDir      = $runDir
        PidFile     = Join-Path $runDir 'server.pid'
        StateFile   = Join-Path $runDir 'server.json'
        StopMarker  = Join-Path $runDir 'stop-requested'
        ReleasesDir = $releasesDir
        CurrentFile = Join-Path $releasesDir 'current.txt'
        BackupsDir  = Join-Path $PbHome 'backups'
        WorkDir     = Join-Path $PbHome 'workspace'
    }
}

function Resolve-NodeExe {
    param([string]$Node)
    $candidates = @()
    if ($Node) { $candidates += $Node }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'vite-plus\data\js_runtime\node\24.21.0\node.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'node.exe not found. Pass -Node <path to node.exe>.'
}

# Loads KEY=VALUE lines from the repo-root .env into this process only.
# Returns the number of keys; values are never printed.
function Import-RepoDotEnv {
    $envFile = Join-Path $PbRepoRoot '.env'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        Write-Warning "No .env at $envFile. The T3 Connect public config will be missing."
        return 0
    }
    $count = 0
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        $text = $line.Trim()
        if ($text.Length -eq 0 -or $text.StartsWith('#')) { continue }
        if ($text.StartsWith('export ')) { $text = $text.Substring(7).Trim() }
        $eq = $text.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $text.Substring(0, $eq).Trim()
        $value = $text.Substring($eq + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        $count++
    }
    return $count
}

# A dev-server URL or baked origin in the environment turns the built server
# into a dev proxy or breaks remote browsers, so the launcher never inherits them.
# T3CODE_PERSONAL_STALL_DIR (start.ps1 sets it to the LIVE %USERPROFILE%\.personal-bots\logs\stalls)
# is cleared for the same reason QA 1.66.33 F3 caught: every test launcher runs
# inside the live server's process tree, so an inherited value put throwaway and
# restore-test stall captures into the live folder where they read as real.
# Cleared, the server derives <baseDir>\userdata\logs\stalls from its own root.
# T3CODE_PERSONAL_SCHEDULERS (=off stops every scheduled turn; restore-test.ps1 sets it after this
# call for its restored copy) is cleared so the live start path (start.ps1, restart.ps1, the logon task)
# never inherits it.
function Clear-DevOriginEnv {
    foreach ($name in @('VITE_DEV_SERVER_URL', 'VITE_HTTP_URL', 'VITE_WS_URL', 'T3CODE_HOME', 'T3CODE_PORT', 'T3CODE_MODE', 'T3CODE_PERSONAL_STALL_DIR', 'T3CODE_PERSONAL_SCHEDULERS')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
}

# The T3 Connect public configuration is baked into the server bundle by
# apps/server/vite.config.ts from loadRepoEnv(), which reads the repo .env/.env.local and
# then the process env. A release built without it can neither pair nor sign in: 1.66.63
# ea54da1ead84 was built in a worktree with no .env, its bundle held no relay URL, and
# release smoke failed twice. build.ps1 refuses before the build and again on the build
# output. Only key names are ever reported; values never leave this process.
$PbPublicConfigRequired = @('T3CODE_RELAY_URL', 'T3CODE_CLERK_PUBLISHABLE_KEY')
# Baked too when the env provides them; a bundle missing one of these is half-configured.
$PbPublicConfigOptional = @(
    'T3CODE_CLERK_CLI_OAUTH_CLIENT_ID',
    'T3CODE_RELAY_CLIENT_OTLP_TRACES_URL',
    'T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET',
    'T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN'
)

function Get-PbPublicConfigValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not $value) { return $null }
    $value = $value.Trim()
    if ($value.Length -eq 0) { return $null }
    return $value
}

# Throws, naming only the empty keys, when the process env vite.config.ts will bake from
# has no relay URL or no Clerk publishable key.
function Assert-PbPublicBuildConfig {
    $missing = @()
    foreach ($name in $PbPublicConfigRequired) {
        if (-not (Get-PbPublicConfigValue -Name $name)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        throw (("Build refused before it starts: the T3 Connect public config is empty ({0}). " -f ($missing -join ', ')) +
            ("Copy the repo .env into {0} (gitignored; values are never printed) and rebuild." -f $PbRepoRoot))
    }
}

# Names the keys whose value the process env provides but the built server bundle does not
# contain. Empty means every required key, and every optional key that was set, is baked in.
# Values are compared in memory only.
function Get-PbMissingBakedPublicConfig {
    param([Parameter(Mandatory = $true)][string]$BinPath)
    if (-not (Test-Path -LiteralPath $BinPath -PathType Leaf)) {
        throw "Cannot check the T3 Connect public config: $BinPath is missing."
    }
    $text = [System.IO.File]::ReadAllText($BinPath)
    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($name in $PbPublicConfigRequired) {
        $value = Get-PbPublicConfigValue -Name $name
        if (-not $value -or $text.IndexOf($value, [System.StringComparison]::Ordinal) -lt 0) {
            $missing.Add($name)
        }
    }
    foreach ($name in $PbPublicConfigOptional) {
        $value = Get-PbPublicConfigValue -Name $name
        if ($value -and $text.IndexOf($value, [System.StringComparison]::Ordinal) -lt 0) {
            $missing.Add($name)
        }
    }
    return $missing.ToArray()
}

function Get-ProcessCommandLine {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $null }
    return [string]$proc.CommandLine
}

# True only when the PID is alive AND its command line names both the release
# binary and the data root we launched. Never identify a server by name.
function Test-PbServerProcess {
    param([int]$ProcessId, [string]$BinPath, [string]$BaseDir)
    if ($ProcessId -le 0 -or -not $BinPath -or -not $BaseDir) { return $false }
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) { return $false }
    $hasBin = $commandLine.IndexOf($BinPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $hasBase = $commandLine.IndexOf($BaseDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    return ($hasBin -and $hasBase)
}

function Read-PbServerState {
    param([Parameter(Mandatory = $true)]$Paths)
    if (-not (Test-Path -LiteralPath $Paths.StateFile -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $Paths.StateFile -Raw | ConvertFrom-Json)
    } catch {
        Write-Warning "Ignoring unreadable $($Paths.StateFile)."
        return $null
    }
}

function Clear-PbServerState {
    param([Parameter(Mandatory = $true)]$Paths)
    foreach ($file in @($Paths.PidFile, $Paths.StateFile)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
    }
}

# server-runtime.json is what a live T3 server writes next to its database.
function Read-PbRuntimeState {
    param([Parameter(Mandatory = $true)][string]$BaseDir)
    $file = Join-Path $BaseDir 'userdata\server-runtime.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# build.ps1 stages by default; only -Activate may switch releases\current.txt.
# -NoActivate is the old opt-out, kept as a harmless no-op for existing callers.
function Resolve-PbBuildActivation {
    param([switch]$Activate, [switch]$NoActivate)
    if ($Activate -and $NoActivate) {
        throw 'build.ps1: -Activate and -NoActivate contradict each other. Staging is the default; pass -Activate only to switch the active release.'
    }
    return [bool]$Activate
}

function Get-PbRelease {
    param([Parameter(Mandatory = $true)]$Paths, [string]$Release)
    if (-not $Release) {
        if (-not (Test-Path -LiteralPath $Paths.CurrentFile -PathType Leaf)) {
            throw "No release is active yet. Run scripts\personal\build.ps1 first."
        }
        $Release = (Get-Content -LiteralPath $Paths.CurrentFile -Raw).Trim()
    }
    $dir = Join-Path $Paths.ReleasesDir $Release
    $bin = Join-Path $dir 'dist\bin.mjs'
    if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) {
        throw "Release '$Release' has no dist\bin.mjs ($bin)."
    }
    return [pscustomobject]@{
        Name        = $Release
        Dir         = $dir
        Bin         = $bin
        VersionFile = Join-Path $dir 'VERSION'
    }
}

# Kills exactly one captured PID and its child tree, then waits for it to go.
function Stop-PbProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $ProcessId /T /F | Out-Null
    } finally {
        $ErrorActionPreference = $previous
    }
    for ($i = 0; $i -lt 50; $i++) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Get-FreeTcpPort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

# Runs node <bin> serve ... through cmd.exe so stdout and stderr land in one
# log file. Returns the cmd.exe process; its command line carries the bin path
# and base dir, which is what stop/status verify before touching it.
function Start-PbServeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$BinPath,
        [Parameter(Mandatory = $true)][string]$BaseDir,
        [Parameter(Mandatory = $true)][string]$LogFile,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$Port = 0,
        [string]$HostName
    )
    $serveArgs = @('"' + $BinPath + '"', 'serve', '--base-dir', '"' + $BaseDir + '"', '--no-browser')
    if ($Port -gt 0) { $serveArgs += @('--port', [string]$Port) }
    if ($HostName) { $serveArgs += @('--host', $HostName) }
    $inner = '"' + $NodeExe + '" ' + ($serveArgs -join ' ') + ' >> "' + $LogFile + '" 2>&1'
    $proc = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c "' + $inner + '"') `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
    # Touching Handle keeps the exit code readable after the process exits.
    $null = $proc.Handle
    return $proc
}

function Remove-PbOldFiles {
    param([string]$Directory, [string]$Filter, [int]$Keep)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    Get-ChildItem -LiteralPath $Directory -Filter $Filter -File |
        Sort-Object Name -Descending |
        Select-Object -Skip $Keep |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
}

# --- Process priority ------------------------------------------------------
# Only the recorded wrapper's direct node child and its relay descendants.
function Get-PbServerProcesses {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name -ErrorAction Stop)
    $queue = New-Object System.Collections.Queue
    $seen = @{}
    $queue.Enqueue(@{ Id = $RootProcessId; Depth = 0 })
    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        foreach ($child in $all) {
            $childId = [int]$child.ProcessId
            if ([int]$child.ParentProcessId -ne [int]$item.Id -or $seen.ContainsKey($childId) -or $childId -eq $RootProcessId) { continue }
            $seen[$childId] = $true
            if (($item.Depth -eq 0 -and $child.Name -ieq 'node.exe') -or $child.Name -ieq 'cloudflared.exe') { $child }
            if ($item.Depth -lt 6) { $queue.Enqueue(@{ Id = $childId; Depth = $item.Depth + 1 }) }
        }
    }
}

# Best effort at startup, fail-closed in smoke. Raising node before the relay
# starts also gives future relay children normal I/O and memory priorities.
# HBOTS_SERVER_PRIORITY=legacy restores the old CPU-only adjustment.
function Set-PbServerPriority {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [int]$WaitSeconds = 20,
        [string]$Priority = 'AboveNormal'
    )
    try {
        $raised = @{}
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ($true) {
            $processes = @(Get-PbServerProcesses -RootProcessId $RootProcessId)
            foreach ($child in $processes) {
                $childId = [int]$child.ProcessId
                if ($raised.ContainsKey($childId)) { continue }
                $io = 2; $memory = 5
                if ($env:HBOTS_SERVER_PRIORITY -eq 'legacy') { $io = -1; $memory = -1 }
                $result = Set-PbProcessPriority -ProcessId $childId -Cpu $Priority -Io $io -Memory $memory
                Write-Host ("Priority {0}: {1}" -f $child.Name, $result)
                if ($result -match 'failed') { Write-Warning "Server priority was not fully applied: $result" }
                else { $raised[$childId] = $true }
            }
            if (($processes.Name -contains 'cloudflared.exe') -or (Get-Date) -ge $deadline) { break }
            Start-Sleep -Seconds 1
        }
        if (-not ($processes.Name -contains 'cloudflared.exe')) { Write-Host 'No T3 Connect relay seen; only server priority applied.' }
    } catch { Write-Warning "Could not set server priority: $($_.Exception.Message)" }
}

# --- Release pruning -------------------------------------------------------
# 62 release directories at ~196 MB each was 7.6 GB, because nothing had ever
# deleted one. Remove-PbOldFiles above only ever covered logs and backups.

<#
.SYNOPSIS
Which release directory names may be deleted. Pure: no filesystem access.

.DESCRIPTION
$Releases is anything with Name and LastWriteTime. The newest $Keep survive,
and so does every name in $Protect whatever its age -- that is where the
active release, the release the recorded server process is actually running,
and the rollback target go. Everything else is returned, newest first.
#>
function Select-PbPrunableReleases {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Releases,
        [int]$Keep = 5,
        [AllowEmptyCollection()][string[]]$Protect = @()
    )
    $protected = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $Protect) {
        if ($name) { [void]$protected.Add(([string]$name).Trim()) }
    }
    $ordered = @($Releases | Sort-Object -Property LastWriteTime -Descending)
    $kept = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if ($Keep -gt 0) {
        foreach ($item in @($ordered | Select-Object -First $Keep)) { [void]$kept.Add([string]$item.Name) }
    }
    $doomed = @()
    foreach ($item in $ordered) {
        $name = [string]$item.Name
        if ($protected.Contains($name)) { continue }
        if ($kept.Contains($name)) { continue }
        $doomed += $name
    }
    return @($doomed)
}

# Bytes a release occupies, ignoring anything behind a reparse point: a
# -CopyExternals release owns its node_modules, a junctioned one points at the
# building checkout and none of it is ours to count.
function Get-PbReleaseSizeBytes {
    param([Parameter(Mandatory = $true)][string]$Path)
    $total = [long]0
    foreach ($entry in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
        if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($entry.PSIsContainer) {
            $sum = (Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force -File -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
            if ($sum) { $total += [long]$sum }
        } else {
            $total += [long]$entry.Length
        }
    }
    return $total
}

# Deletes one release directory. Every reparse point directly inside it is
# unlinked first and never followed: node_modules is often a junction into the
# building checkout, and deleting through it would take the developer's tree
# with it. cmd's rmdir then handles the depth that Remove-Item refuses.
function Remove-PbReleaseDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    foreach ($entry in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
        if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { continue }
        if ($entry.PSIsContainer) {
            [System.IO.Directory]::Delete($entry.FullName)
        } else {
            [System.IO.File]::Delete($entry.FullName)
        }
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $env:ComSpec /d /s /c ('rmdir /s /q "' + $Path + '"') 2>&1 | Out-Null
    $ErrorActionPreference = $previous
    return (-not (Test-Path -LiteralPath $Path))
}

<#
.SYNOPSIS
Deletes old release directories, keeping the newest $Keep plus everything in
$Protect. -DryRun reports without touching anything.
#>
function Remove-PbOldReleases {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [int]$Keep = 5,
        [AllowEmptyCollection()][string[]]$Protect = @(),
        [switch]$DryRun
    )
    if (-not (Test-Path -LiteralPath $Paths.ReleasesDir -PathType Container)) {
        Write-Host 'No releases directory; nothing to prune.'
        return
    }

    # Read the live guards here rather than trusting the caller: the active
    # release, whatever the recorded process is really running, and the caller's
    # own additions (the rollback target).
    $protect = @($Protect)
    if (Test-Path -LiteralPath $Paths.CurrentFile -PathType Leaf) {
        $protect += (Get-Content -LiteralPath $Paths.CurrentFile -Raw).Trim()
    }
    $state = Read-PbServerState -Paths $Paths
    if ($state) {
        if ($state.release) { $protect += [string]$state.release }
        if ($state.binPath) {
            # ...\releases\<name>\dist\bin.mjs -- the directory actually loaded,
            # whatever the release field claims.
            $protect += Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent ([string]$state.binPath)))
        }
    }
    $protect = @($protect | Where-Object { $_ } | Select-Object -Unique)

    $all = @(Get-ChildItem -LiteralPath $Paths.ReleasesDir -Directory -Force |
            Select-Object -Property Name, LastWriteTime)
    $doomed = Select-PbPrunableReleases -Releases $all -Keep $Keep -Protect $protect

    Write-Host ("Releases: {0} present, keeping the newest {1} plus {2} protected ({3})." -f `
            $all.Count, $Keep, $protect.Count, ($protect -join ', '))
    if ($doomed.Count -eq 0) {
        Write-Host '  Nothing to prune.'
        return
    }

    $freed = [long]0
    $removed = 0
    foreach ($name in $doomed) {
        # Belt and braces: never delete something the guards named, whatever the
        # selection did.
        if ($protect -contains $name) { throw "Refusing to prune protected release $name." }
        $dir = Join-Path $Paths.ReleasesDir $name
        $size = Get-PbReleaseSizeBytes -Path $dir
        if ($DryRun) {
            Write-Host ("  would remove {0} ({1:N1} MB)" -f $name, ($size / 1MB))
            $freed += $size
            continue
        }
        if (Remove-PbReleaseDirectory -Path $dir) {
            Write-Host ("  removed {0} ({1:N1} MB)" -f $name, ($size / 1MB))
            $freed += $size
            $removed++
        } else {
            Write-Warning "  could not remove $dir; leaving it in place."
        }
    }
    if ($DryRun) {
        Write-Host ("Dry run: {0} release(s), {1:N2} GB would be freed." -f $doomed.Count, ($freed / 1GB))
    } else {
        Write-Host ("Pruned {0} release(s), {1:N2} GB freed." -f $removed, ($freed / 1GB))
    }
}

function Invoke-PbNative {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $code."
    }
}

# The upstream T3 Code commit (12 chars) a checkout is synced through: the
# merge-base with upstream/main. A checkout with no upstream remote gets ''.
# (git prints nothing there, and PowerShell 5.1 casts that empty output to
# $null rather than '', which made `.Trim()` throw and the build crash.)
function Get-PbUpstreamBase {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $base = [string](& git -C $RepoRoot merge-base HEAD upstream/main 2>$null)
    $ErrorActionPreference = $previous
    if ($null -eq $base) { return '' }
    $base = $base.Trim()
    if ($base.Length -gt 12) { $base = $base.Substring(0, 12) }
    return $base
}
