# Shared helpers for the nightly Claude Code update pipeline. Dot-source only:
#   . (Join-Path $PSScriptRoot 'updates-common.ps1')
# Windows PowerShell 5.1 compatible (no ??, no ternary, no && chains).
#
# The pipeline in one paragraph: the Updates bot (a routine task inside the
# server) runs `nightly.ps1 -Step preflight`, reviews, applies what it rates
# safe as one commit per proposal, and runs `nightly.ps1 -Step ship`, which
# launches nightly-pipeline.ps1 DETACHED (WMI Win32_Process.Create: a child of
# WmiPrvSE, outside the server's process tree and job, so the restart cannot
# kill it). The pipeline gates, reverts on red, bumps, pushes, builds, waits for
# the bot's task to end, restarts, verifies, rolls back on failure, records
# the outcome and posts the morning report through the "Morning report" relay
# routine. Pure decisions live in functions below and are tested by
# updates.tests.ps1.

. (Join-Path $PSScriptRoot '..\common.ps1')

$UpdatesHome = Join-Path $PbHome 'claude-code-updates'
$UpdatesLockFile = Join-Path $UpdatesHome 'lock.json'
$UpdatesTokenFile = Join-Path $UpdatesHome 'report-hook-token'
$UpdatesLastOutcomeFile = Join-Path $UpdatesHome 'last-outcome.json'
$UpdatesDryWorktree = Join-Path $UpdatesHome 'dry-worktree'
# The release trunk: builders fast-forward it with every release, and the
# nightly run pushes its own release commit to it. (Until 2026-10-05 this read
# fix/inline-cards, the trunk of 1.42; every preflight since 26 Sep refused.)
$UpdatesBranch = 'personal-bots/main'
$UpdatesBotId = 'personal-claude-code-updates'
$UpdatesLedgerCli = Join-Path $PSScriptRoot 'ledger.ts'
$UpdatesNotesDir = 'C:\Claude\AI\personal-bots-notes'
if ($env:PB_NOTES_DIR) { $UpdatesNotesDir = $env:PB_NOTES_DIR }
$UpdatesLedger = Join-Path $UpdatesNotesDir 'claude-code-updates\proposals.json'
$UpdatesUrgotAlerts = 'C:\Claude\AI\urgot\data\alerts\personal-bots-updates.md'
$UpdatesGitIdentity = @('-c', 'user.email=harout_b5@live.com', '-c', 'user.name=haroutB5')
# Same prefix as URGENT_REPORT_PREFIX in proposalLedger.ts; updates.tests.ps1 checks they match.
$UpdatesUrgentPrefix = 'Needs attention'
# A lock older than this with no live owner is left over from a dead run.
$UpdatesLockMaxAgeHours = 5
# Working directory of the helper processes below; the server also writes the
# report hook token here.
New-Item -ItemType Directory -Force -Path $UpdatesHome | Out-Null

function Get-UpdatesRunDir([string]$RunId) {
    return (Join-Path (Join-Path $UpdatesHome 'runs') $RunId)
}

# ---------------------------------------------------------------- processes

# Quotes one argument by the Windows argv rules (CommandLineToArgvW).
function ConvertTo-UpdatesArg([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') {
            [void]$builder.Append('\' * ($slashes * 2 + 1))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append('\' * $slashes); $slashes = 0 }
        [void]$builder.Append($ch)
    }
    [void]$builder.Append('\' * ($slashes * 2))
    [void]$builder.Append('"')
    return $builder.ToString()
}

# Runs a native program, captures both streams, kills its tree on timeout.
function Invoke-UpdatesProc {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 3600,
        [string]$LogPath
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (@($ArgList | ForEach-Object { ConvertTo-UpdatesArg ([string]$_) }) -join ' ')
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $proc.StandardInput.Close()
    $timedOut = $false
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        $timedOut = $true
        [void](Stop-PbProcessTree -ProcessId $proc.Id)
        $proc.WaitForExit()
    }
    $out = $outTask.Result
    $err = $errTask.Result
    if ($LogPath) {
        Set-Content -LiteralPath $LogPath -Value ($out + "`n--- stderr ---`n" + $err) -Encoding UTF8
    }
    $code = $proc.ExitCode
    if ($timedOut) { $code = 124 }
    return [pscustomobject]@{ Code = $code; Out = [string]$out; Err = [string]$err; TimedOut = $timedOut }
}

function Invoke-UpdatesGit {
    param([Parameter(Mandatory = $true)][string]$Repo, [string[]]$GitArgs, [switch]$AllowFail)
    $res = Invoke-UpdatesProc -FilePath 'git' -ArgList (@('-C', $Repo) + $GitArgs) -WorkingDirectory $Repo -TimeoutSeconds 900
    if ($res.Code -ne 0 -and -not $AllowFail) {
        throw ("git {0} failed ({1}): {2}" -f ($GitArgs -join ' '), $res.Code, $res.Err.Trim())
    }
    return $res
}

function Get-UpdatesGitText([string]$Repo, [string[]]$GitArgs) {
    return (Invoke-UpdatesGit -Repo $Repo -GitArgs $GitArgs).Out.Trim()
}

function Get-UpdatesGitLines([string]$Repo, [string[]]$GitArgs) {
    return @((Invoke-UpdatesGit -Repo $Repo -GitArgs $GitArgs).Out -split "`r?`n" | Where-Object { $_.Length -gt 0 })
}

<#
.SYNOPSIS
Starts a PowerShell script fully detached: created by WMI (Win32_Process.Create),
so its parent is WmiPrvSE, not the caller. It survives the caller's process tree
being killed (restart.ps1 kills the server tree, which contains the bot that
called us) and is in no job object of ours. Returns the new PID.
#>
function Start-UpdatesDetached {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ScriptArgs = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArgs
    $commandLine = (ConvertTo-UpdatesArg $powershellExe) + ' ' + (@($argv | ForEach-Object { ConvertTo-UpdatesArg ([string]$_) }) -join ' ')
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $commandLine
        CurrentDirectory = $WorkingDirectory
    }
    if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue) for $ScriptPath." }
    return [int]$result.ProcessId
}

# ---------------------------------------------------------------- lock

function Read-UpdatesLock {
    if (-not (Test-Path -LiteralPath $UpdatesLockFile -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $UpdatesLockFile -Raw | ConvertFrom-Json) } catch { return $null }
}

<#
.SYNOPSIS
Whether a lock can be taken over. Pure: $IsAlive decides whether a PID lives.
A lock with a recorded owner PID is stale once that process is gone. Without
one (the bot stage: the preflight process has exited and the bot is working)
it is stale only after $MaxAgeHours since its last update.
#>
function Test-UpdatesLockStale {
    param(
        $Lock,
        [datetime]$Now,
        [scriptblock]$IsAlive,
        [double]$MaxAgeHours = $UpdatesLockMaxAgeHours
    )
    if ($null -eq $Lock) { return $true }
    $updated = $null
    try { $updated = ([datetime]$Lock.updatedAt).ToUniversalTime() } catch { return $true }
    $ownerPid = 0
    if ($Lock.PSObject.Properties.Name -contains 'pid' -and $Lock.pid) { $ownerPid = [int]$Lock.pid }
    if ($ownerPid -gt 0 -and -not (& $IsAlive $ownerPid)) { return $true }
    return (($Now.ToUniversalTime() - $updated).TotalHours -gt $MaxAgeHours)
}

function Test-UpdatesPidAlive([int]$ProcessId) {
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Write-UpdatesLock([hashtable]$Fields) {
    New-Item -ItemType Directory -Force -Path $UpdatesHome | Out-Null
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $lock = [ordered]@{ runId = $null; mode = $null; stage = $null; pid = 0; startedAt = $now; updatedAt = $now }
    $old = Read-UpdatesLock
    if ($old) { foreach ($prop in $old.PSObject.Properties) { $lock[$prop.Name] = $prop.Value } }
    foreach ($key in $Fields.Keys) { $lock[$key] = $Fields[$key] }
    $lock.updatedAt = $now
    $temp = "$UpdatesLockFile.$PID.tmp"
    Set-Content -LiteralPath $temp -Value ($lock | ConvertTo-Json) -Encoding ASCII
    Move-Item -LiteralPath $temp -Destination $UpdatesLockFile -Force
}

# Takes the lock for a run, or throws naming who holds it.
function Enter-UpdatesLock([string]$RunId, [string]$Mode) {
    $lock = Read-UpdatesLock
    if ($lock -and $lock.runId -ne $RunId -and -not (Test-UpdatesLockStale -Lock $lock -Now (Get-Date) -IsAlive ${function:Test-UpdatesPidAlive})) {
        throw "another nightly run holds the lock (run $($lock.runId), stage $($lock.stage), since $($lock.startedAt))"
    }
    if (Test-Path -LiteralPath $UpdatesLockFile) { Remove-Item -LiteralPath $UpdatesLockFile -Force }
    Write-UpdatesLock @{ runId = $RunId; mode = $Mode; stage = 'preflight'; pid = 0 }
}

function Assert-UpdatesLockOwner([string]$RunId) {
    $lock = Read-UpdatesLock
    if (-not $lock -or $lock.runId -ne $RunId) {
        $holder = 'nobody'
        if ($lock) { $holder = "run $($lock.runId)" }
        throw "the nightly lock is not held by run $RunId (held by $holder)"
    }
}

function Exit-UpdatesLock([string]$RunId) {
    $lock = Read-UpdatesLock
    if ($lock -and $lock.runId -eq $RunId -and (Test-Path -LiteralPath $UpdatesLockFile)) {
        Remove-Item -LiteralPath $UpdatesLockFile -Force
    }
}

<#
.SYNOPSIS
What else could be building or deploying right now: the weekly upstream sync
and its nightly probe (their own locks, owner alive), and any build/restart
script process. Detection by command line is read-only: nothing is killed.
#>
function Get-UpdatesBlockers {
    $blockers = @()
    $syncHome = Join-Path $PbHome 'upstream-sync'
    foreach ($name in @('lock', 'probe-lock')) {
        $file = Join-Path $syncHome $name
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $other = $null
            try { $other = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { $other = $null }
            if ($other -and $other.pid -and (Test-UpdatesPidAlive ([int]$other.pid))) {
                $blockers += "the upstream sync $name is held (pid $($other.pid), since $($other.startedAt))"
            }
        }
    }
    $procs = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, CommandLine -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
        $line = [string]$proc.CommandLine
        if (-not $line -or [int]$proc.ProcessId -eq $PID) { continue }
        if (Test-UpdatesBuildProcess -Name ([string]$proc.Name) -CommandLine $line) {
            $blockers += "a build or deploy is running (pid $($proc.ProcessId): $($line.Substring(0, [math]::Min(160, $line.Length))))"
        }
    }
    return , $blockers
}

<#
.SYNOPSIS
Whether a process is itself a build, restart or upstream sync. Pure. A shell
that merely carries the script name in its command text is not one: an agent's
`bash.exe -c "... build.ps1 ..."` made the 30 Sep preflight refuse next to a
real build, and any bot that greps or edits these scripts at 04:00 would do
the same. The real thing runs `powershell -File <script>` (or the vp build
chain), which this still matches.
#>
function Test-UpdatesBuildProcess([string]$Name, [string]$CommandLine) {
    if ($Name -match '^(bash|zsh)(\.exe)?$') { return $false }
    if ($CommandLine -match '(?i)-File\s+"?[^\s"]*scripts[\\/]personal[\\/](build|restart)\.ps1') { return $true }
    if ($CommandLine -match '(?i)-File\s+"?[^\s"]*upstream-sync\.ps1') { return $true }
    if ($CommandLine -match 'run --filter t3 build') { return $true }
    return $false
}

# ---------------------------------------------------------------- versions and releases

# 1.35.0 -> 1.35.1. Throws on anything that is not x.y.z.
function Get-UpdatesNextPatchVersion([string]$Version) {
    if ($Version.Trim() -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "app-version.txt holds '$Version', not x.y.z." }
    return ('{0}.{1}.{2}' -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1))
}

# key=value lines (VERSION, /version.txt) into a hashtable.
function ConvertFrom-UpdatesKeyValue([string]$Text) {
    $map = @{}
    foreach ($line in ($Text -split "`r?`n")) {
        $eq = $line.IndexOf('=')
        if ($eq -gt 0) { $map[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim() }
    }
    return $map
}

<#
.SYNOPSIS
The release to roll back to. Pure. The release the recorded server process is
running right before the restart wins (it is what was live); the one recorded
at preflight is the fallback. Never the new release itself, never a dirty one.
#>
function Select-UpdatesRollbackTarget {
    param([string]$RunningRelease, [string]$PreflightRelease, [string]$NewRelease)
    foreach ($candidate in @($RunningRelease, $PreflightRelease)) {
        if (-not $candidate) { continue }
        if ($candidate -eq $NewRelease) { continue }
        if ($candidate -match '-dirty-') { continue }
        return $candidate
    }
    return $null
}

# Removes the half-built release folder a failed build.ps1 leaves behind (its
# name is the HEAD sha of the run). Never the active release, never the one the
# server is running, never an empty name. Returns $true when a folder was
# removed. The folder goes through Remove-PbReleaseDirectory, which unlinks
# junctions first and so never follows node_modules into the checkout.
function Remove-UpdatesFailedBuildRelease {
    param([Parameter(Mandatory = $true)]$Paths, [string]$Release)
    if (-not $Release -or $Release -notmatch '^[0-9a-f]{7,40}(-dirty-[0-9A-Za-z]+)?$') { return $false }
    $current = ''
    if (Test-Path -LiteralPath $Paths.CurrentFile -PathType Leaf) { $current = (Get-Content -LiteralPath $Paths.CurrentFile -Raw).Trim() }
    $state = Read-PbServerState -Paths $Paths
    $live = ''
    if ($state) { $live = [string]$state.release }
    if ($Release -eq $current -or $Release -eq $live) { return $false }
    $dir = Join-Path $Paths.ReleasesDir $Release
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
    return (Remove-PbReleaseDirectory -Path $dir)
}

# The live release's externals mode from its VERSION file ('copied' or 'junction').
function Get-UpdatesReleaseExternals([string]$ReleaseName) {
    $paths = Get-PbPaths -Root dev
    $file = Join-Path (Join-Path $paths.ReleasesDir $ReleaseName) 'VERSION'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    $map = ConvertFrom-UpdatesKeyValue ((Get-Content -LiteralPath $file) -join "`n")
    return [string]$map['externals']
}

# ---------------------------------------------------------------- git decisions

<#
.SYNOPSIS
The commits a run made, oldest first, and a refusal for anything the pipeline
cannot undo with plain reverts (a merge commit) or that touches what the bot
must never touch.
#>
function Get-UpdatesForbiddenPaths([string[]]$ChangedPaths) {
    $forbidden = @()
    foreach ($path in $ChangedPaths) {
        $p = $path -replace '\\', '/'
        if ($p -match '(^|/)\.env($|\.)' -or $p -match '(^|/)secrets/' -or $p -eq 'scripts/personal/app-version.txt') {
            $forbidden += $p
        }
    }
    return , $forbidden
}

<#
.SYNOPSIS
Commits in the run's range that no proposal of this run recorded (ledger
"applied ... --commits"). Pure. Someone else committing in the checkout while
the bot worked would otherwise be gated, shipped or reverted as the bot's.
Recorded ids may be abbreviated (7+ characters).
#>
function Get-UpdatesForeignCommits {
    param([string[]]$RangeCommits, [string[]]$RecordedCommits)
    $recorded = @($RecordedCommits | Where-Object { $_ -and $_.Trim().Length -ge 7 } | ForEach-Object { $_.Trim().ToLowerInvariant() })
    $foreign = @()
    foreach ($sha in $RangeCommits) {
        $full = $sha.ToLowerInvariant()
        if (-not ($recorded | Where-Object { $full.StartsWith($_) })) { $foreign += $sha }
    }
    return , $foreign
}

<#
.SYNOPSIS
Reverts a run's commits with new revert commits, newest first. Never resets,
amends or forces. A revert that does not apply cleanly is aborted and throws;
the caller reports it and leaves the tree for a human.
#>
function Invoke-UpdatesRevert {
    param([Parameter(Mandatory = $true)][string]$Repo, [string[]]$Commits, [string]$Reason)
    $created = @()
    $newestFirst = @($Commits)
    [array]::Reverse($newestFirst)
    foreach ($sha in $newestFirst) {
        $parents = @((Get-UpdatesGitText -Repo $Repo -GitArgs @('rev-list', '--parents', '-n', '1', $sha)) -split ' ')
        if ($parents.Count -gt 2) { throw "commit $sha is a merge; not reverting it automatically" }
        $res = Invoke-UpdatesGit -Repo $Repo -GitArgs ($UpdatesGitIdentity + @('revert', '--no-edit', $sha)) -AllowFail
        if ($res.Code -ne 0) {
            [void](Invoke-UpdatesGit -Repo $Repo -GitArgs @('revert', '--abort') -AllowFail)
            throw "git revert $sha did not apply cleanly: $($res.Err.Trim())"
        }
        $created += (Get-UpdatesGitText -Repo $Repo -GitArgs @('rev-parse', '--short=10', 'HEAD'))
    }
    if ($Reason) {
        # Record why in the log only; the revert commits keep git's standard message.
        Write-Host "Reverted $($Commits.Count) commit(s): $Reason"
    }
    return , $created
}

# What a checkout can differ in from the live release without holding unshipped
# code. Pure. Three kinds of path are not part of a release: notes (top-level
# *.md such as HANDOFF-<n>.md, and docs/), and the release tooling under
# scripts/personal/, which runs from the checkout and is never bundled into
# releases\<sha>\dist (build.ps1 copies only apps\server\dist). The one file in
# that folder a release does carry is app-version.txt (the number in VERSION
# and /version.txt), so a change to it is not ignorable. Everything else
# (apps, packages, lockfile, root config, other scripts) is code.
function Test-UpdatesNotInRelease([string]$Path) {
    $p = ($Path -replace '\\', '/').Trim()
    if ($p -eq 'scripts/personal/app-version.txt') { return $false }
    if ($p -match '^[^/]+\.md$') { return $true }
    if ($p -like 'docs/*') { return $true }
    if ($p -like 'scripts/personal/*') { return $true }
    return $false
}

# The paths of a diff that would change a release (see above), in order.
function Get-UpdatesCodePaths([string[]]$ChangedPaths) {
    # No leading comma: callers wrap the call in @(...). `return , @()` would reach them
    # as ONE element (an empty array) and read "1 path" for no change at all.
    return @($ChangedPaths | Where-Object { $_ -and -not (Test-UpdatesNotInRelease $_) })
}

<#
.SYNOPSIS
How the checkout relates to origin. Pure. 'same'; 'behind' (origin only has
newer commits, so a fast-forward loses nothing); 'ahead' (unpushed commits);
'diverged'. Only 'behind' is healed, and only by merge --ff-only.
#>
function Get-UpdatesSyncState([int]$Ahead, [int]$Behind) {
    if ($Ahead -eq 0 -and $Behind -eq 0) { return 'same' }
    if ($Ahead -eq 0) { return 'behind' }
    if ($Behind -eq 0) { return 'ahead' }
    return 'diverged'
}

# Whether node_modules was installed from the lockfile now in the checkout:
# the marker this script writes after its own install, or pnpm's own copy of
# the lockfile (node_modules\.pnpm\lock.yaml) being the same file.
function Test-UpdatesDependenciesCurrent([string]$Root) {
    $lock = Join-Path $Root 'pnpm-lock.yaml'
    if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) { return $true }
    $modules = Join-Path $Root 'node_modules'
    if (-not (Test-Path -LiteralPath $modules -PathType Container)) { return $false }
    $want = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
    $marker = Join-Path $modules '.pb-installed-lock.sha256'
    if ((Test-Path -LiteralPath $marker -PathType Leaf) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $want)) { return $true }
    $installed = Join-Path $modules '.pnpm\lock.yaml'
    if ((Test-Path -LiteralPath $installed -PathType Leaf) -and ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -eq $want)) { return $true }
    return $false
}

function Set-UpdatesDependenciesMarker([string]$Root) {
    $lock = Join-Path $Root 'pnpm-lock.yaml'
    $modules = Join-Path $Root 'node_modules'
    if (-not (Test-Path -LiteralPath $lock -PathType Leaf) -or -not (Test-Path -LiteralPath $modules -PathType Container)) { return }
    Set-Content -LiteralPath (Join-Path $modules '.pb-installed-lock.sha256') -Value (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash -Encoding ASCII
}

# ---------------------------------------------------------------- gates

function Get-UpdatesKnownFailures {
    $file = Join-Path $PSScriptRoot '..\sync\known-test-failures.txt'
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    return @(Get-Content -LiteralPath $file | ForEach-Object { $_.Trim() } |
            Where-Object { $_.Length -gt 0 -and -not $_.StartsWith('#') })
}

# Files with a lint ERROR (warnings do not count) in `vp lint` output, forward
# slashes. Two layouts exist: the one-line `file:line:col: error rule: text`, and
# the default one `vp lint` prints when piped (what the nightly captured on
# 6 Oct): a header line `  x rule(name): text` for an error (`  ! ...` for a
# warning), then a code frame whose first line is `,-[file:line:col]`. The
# 6 Oct run could not read the second layout, saw exit 1 with no files listed,
# called it a crash and reverted a good run.
function Get-UpdatesLintErrorFiles([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    # The error mark is "x" in the plain layout and a multiplication sign or a heavy x in a Unicode terminal; the warning mark is "!" or a warning sign.
    $errorMark = '^\s*[x\u00d7\u2716]\s+\S'
    $warningMark = '^\s*[!\u26a0]\s+\S'
    $files = New-Object System.Collections.Generic.HashSet[string]
    $inError = $false
    foreach ($line in ($clean -split "`r?`n")) {
        if ($line -match '^\s*(\S.*?):\d+:\d+: error\b') {
            [void]$files.Add(($Matches[1] -replace '\\', '/').Trim())
            $inError = $false
        } elseif ($line -match $errorMark) {
            $inError = $true
        } elseif ($line -match $warningMark) {
            $inError = $false
        } elseif ($inError -and $line -match ',-\[(.+?):\d+:\d+\]') {
            [void]$files.Add(($Matches[1] -replace '\\', '/').Trim())
            $inError = $false
        }
    }
    return @($files | Sort-Object)
}

# `vp lint` ends with "Found N warnings and M errors."; no such line means the
# run did not finish (a crash or a timeout). Returns $null then.
function Get-UpdatesLintSummary([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    $m = [regex]::Matches($clean, 'Found (\d+) warnings? and (\d+) errors?')
    if ($m.Count -eq 0) { return $null }
    $last = $m[$m.Count - 1]
    return [pscustomobject]@{ Warnings = [int]$last.Groups[1].Value; Errors = [int]$last.Groups[2].Value }
}

function Get-UpdatesVitestFailures([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    return @($clean -split "`r?`n" | Where-Object { $_ -match '^\s*FAIL\s+\S+' } |
            ForEach-Object { ($_ -replace '^\s*FAIL\s+', '').Trim() } | Sort-Object -Unique)
}

<#
.SYNOPSIS
The real type errors in tsc output. tsc here also prints the Effect language
service's suggestions and warnings, and exits 1 on a warning alone (a
pre-existing one in connections/service.test.ts made every run red in the
second dry run), so the typecheck gates judge by `error TS` lines, not the exit code.
#>
function Get-UpdatesTscErrors([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    return , @($clean -split "`r?`n" | Where-Object { $_ -match '\): error TS\d+:' } | ForEach-Object { $_.Trim() })
}

# The gates the brief names: server personal tests, web personal tests,
# typecheck, lint. perf:check needs the live server, so it runs after the
# restart (nightly-pipeline.ps1). Never an unfiltered `vp test run` in apps\server.
function Get-UpdatesGateList([string]$Root) {
    # Absolute: Process.Start resolves a relative FileName against this process's
    # directory, not the gate's WorkingDirectory (the 2026-09-24 dry run hit that).
    $tsc = Join-Path $Root 'node_modules\.bin\tsc.cmd'
    $vp = Join-Path $Root 'node_modules\.bin\vp.cmd'
    return @(
        @{ Name = 'test-server'; Dir = 'apps\server'; File = $vp; Args = @('test', 'run', 'src/personal'); Kind = 'vitest' },
        @{ Name = 'test-web'; Dir = 'apps\web'; File = $vp; Args = @('test', 'run', '--project', 'unit', 'src/features/personal'); Kind = 'vitest' },
        @{ Name = 'typecheck-contracts'; Dir = 'packages\contracts'; File = $tsc; Args = @('--noEmit'); Kind = 'tsc' },
        @{ Name = 'typecheck-shared'; Dir = 'packages\shared'; File = $tsc; Args = @('--noEmit'); Kind = 'tsc' },
        @{ Name = 'typecheck-client-runtime'; Dir = 'packages\client-runtime'; File = $tsc; Args = @('--noEmit'); Kind = 'tsc' },
        @{ Name = 'typecheck-server'; Dir = 'apps\server'; File = $tsc; Args = @('--noEmit'); Kind = 'tsc' },
        @{ Name = 'typecheck-web'; Dir = 'apps\web'; File = $tsc; Args = @('--noEmit'); Kind = 'tsc' },
        @{ Name = 'lint'; Dir = '.'; File = $vp; Args = @('lint', '--report-unused-disable-directives'); Kind = 'lint' }
    )
}

<#
.SYNOPSIS
Runs every gate; returns the red ones. The lint gate is red only for an error in
a file the run changed (-ChangedPaths): `main` itself carries pre-existing lint
errors in files the nightly never touches (14 in 7 files on 5 Oct, from upstream
merges), and gating on the whole repo reverted every run. A vitest FAIL listed in
sync\known-test-failures.txt is ignored; other failing files get one isolated
re-run (timing flakes on this laptop) and count only if a test fails twice.
#>
function Invoke-UpdatesGates {
    param([object[]]$Gates, [string]$Root, [string]$LogDir, [scriptblock]$Log, [string[]]$ChangedPaths = @())
    $known = Get-UpdatesKnownFailures
    $red = New-Object System.Collections.Generic.List[string]
    foreach ($gate in $Gates) {
        $dir = Join-Path $Root $gate.Dir
        # Not $logFile: callers' log scriptblocks resolve variable names dynamically.
        $gateLog = Join-Path $LogDir ('gate-{0}.log' -f $gate.Name)
        & $Log "gate $($gate.Name) ..."
        try {
            $res = Invoke-UpdatesProc -FilePath $gate.File -ArgList $gate.Args -WorkingDirectory $dir -TimeoutSeconds 2400 -LogPath $gateLog
        } catch {
            # A gate that cannot even start is red, not a pipeline crash.
            $red.Add("$($gate.Name) could not start: $($_.Exception.Message)") | Out-Null
            continue
        }
        if ($gate.Kind -eq 'exit') {
            if ($res.Code -ne 0) { $red.Add("$($gate.Name) exited $($res.Code) (log $gateLog)") | Out-Null }
            continue
        }
        if ($gate.Kind -eq 'lint') {
            $lintText = $res.Out + "`n" + $res.Err
            $errorFiles = @(Get-UpdatesLintErrorFiles -Output $lintText)
            $summary = Get-UpdatesLintSummary -Output $lintText
            $mine = @($errorFiles | Where-Object { $file = $_; @($ChangedPaths | Where-Object { ($_ -replace '\\', '/') -eq $file }).Count -gt 0 })
            if ($mine.Count -gt 0) {
                $red.Add("$($gate.Name): lint error(s) in a file this run changed: $($mine -join ', ') (log $gateLog)") | Out-Null
            } elseif ($res.TimedOut -or ($res.Code -ne 0 -and $null -eq $summary -and $errorFiles.Count -eq 0)) {
                # No "Found N warnings and M errors" line: the run did not finish.
                $red.Add("$($gate.Name) exited $($res.Code) without a lint summary (crash or timeout; log $gateLog)") | Out-Null
            } elseif ($null -ne $summary -and $summary.Errors -gt 0 -and $errorFiles.Count -eq 0) {
                # Errors were counted but none could be tied to a file: the layout changed. Never pass on a guess.
                $red.Add("$($gate.Name): lint counted $($summary.Errors) error(s) but none could be tied to a file (output layout changed?; log $gateLog)") | Out-Null
            } elseif ($errorFiles.Count -gt 0) {
                & $Log "gate $($gate.Name): $($errorFiles.Count) file(s) with pre-existing lint errors, none changed by this run"
            }
            continue
        }
        if ($gate.Kind -eq 'tsc') {
            $errors = Get-UpdatesTscErrors -Output ($res.Out + "`n" + $res.Err)
            if ($errors.Count -gt 0) {
                $red.Add("$($gate.Name): $($errors.Count) type error(s), first: $($errors[0]) (log $gateLog)") | Out-Null
            } elseif ($res.Code -ne 0 -and $res.TimedOut) {
                $red.Add("$($gate.Name) timed out (log $gateLog)") | Out-Null
            }
            continue
        }
        if ($res.Code -eq 0) { continue }
        $failures = @(Get-UpdatesVitestFailures -Output ($res.Out + "`n" + $res.Err))
        $unknown = @($failures | Where-Object { $line = $_; -not ($known | Where-Object { $line.Contains($_) }) })
        if ($failures.Count -eq 0) {
            $red.Add("$($gate.Name) exited $($res.Code) with no FAIL lines (crash or timeout; log $gateLog)") | Out-Null
            continue
        }
        if ($unknown.Count -eq 0) { & $Log "gate $($gate.Name): only known pre-existing failures"; continue }
        $files = @($unknown | ForEach-Object { ($_ -split '\s+>\s+')[0] } | Sort-Object -Unique)
        & $Log "gate $($gate.Name): re-running $($files.Count) failing file(s) once"
        $rerunArgs = @('test', 'run')
        if ($gate.Args -contains '--project') { $rerunArgs += @('--project', 'unit') }
        $rerunLog = Join-Path $LogDir ('gate-{0}-rerun.log' -f $gate.Name)
        $rerun = Invoke-UpdatesProc -FilePath $gate.File -ArgList ($rerunArgs + $files) -WorkingDirectory $dir -TimeoutSeconds 1800 -LogPath $rerunLog
        if ($rerun.Code -eq 0) { & $Log "gate $($gate.Name): passed on re-run (flaky: $($unknown -join '; '))"; continue }
        $again = @(Get-UpdatesVitestFailures -Output ($rerun.Out + "`n" + $rerun.Err))
        $repeated = @($again | Where-Object { $unknown -contains $_ })
        if ($repeated.Count -gt 0) {
            $red.Add("$($gate.Name): $($repeated -join '; ') (log $rerunLog)") | Out-Null
        } elseif ($again.Count -eq 0) {
            $red.Add("$($gate.Name) re-run exited $($rerun.Code) with no FAIL lines (log $rerunLog)") | Out-Null
        } else {
            & $Log "gate $($gate.Name): no test failed twice (flaky)"
        }
    }
    return , $red.ToArray()
}

# ---------------------------------------------------------------- is anything working

# The same read-only check the hbots idle waiter uses (restart-<version>.ps1 runs
# its own idle-check.mjs; keep the two in step): a chat session of a live thread
# that is running, or a task that is not finished (queued, running, waiting for
# an agent, the user or the browser, rate limited). A thread deleted mid-turn
# keeps a 'running' session row, so only live threads count. Prints "idle" or
# "busy sessions=<n> tasks=<n>".
$UpdatesIdleQuery = 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.PB_UPDATES_IDLE_DB,{readOnly:true});db.exec("PRAGMA busy_timeout=5000");const s=db.prepare("select count(*) n from projection_thread_sessions s join projection_threads t on t.thread_id=s.thread_id where s.status=''running'' and t.deleted_at is null").get().n;const t=db.prepare("select count(*) n from personal_tasks where status in (''queued'',''running'',''waiting_for_agent'',''waiting_for_user'',''waiting_for_browser'',''rate_limited'')").get().n;db.close();console.log(s===0&&t===0?"idle":"busy sessions="+s+" tasks="+t)'

<#
.SYNOPSIS
One look at whether any bot or task is working. Returns "idle", "busy sessions=<n>
tasks=<n>", or "unreadable: <why>" (which counts as busy: when in doubt, no restart).
PB_UPDATES_IDLE_DB points the check at another state.sqlite (the tests do).
#>
function Get-PbBusyState {
    param([string]$StateDb)
    if (-not $StateDb) { $StateDb = $env:PB_UPDATES_IDLE_DB }
    if (-not $StateDb) { $StateDb = Join-Path (Get-PbPaths -Root dev).StateDir 'state.sqlite' }
    $env:PB_UPDATES_IDLE_DB = $StateDb
    $res = Invoke-UpdatesProc -FilePath (Resolve-NodeExe) -ArgList @('--disable-warning=ExperimentalWarning', '-e', $UpdatesIdleQuery) -WorkingDirectory $UpdatesHome -TimeoutSeconds 60
    $text = $res.Out.Trim()
    if ($res.Code -eq 0 -and ($text -eq 'idle' -or $text -match '^busy sessions=\d+ tasks=\d+$')) { return $text }
    $why = $res.Err.Trim()
    if ($why.Length -gt 160) { $why = $why.Substring(0, 160) }
    return "unreadable: exit $($res.Code) $why"
}

<#
.SYNOPSIS
Waits until EVERY bot and task is idle (Harout's rule: never restart while any bot
or task is still working), like the idle waiter: $Streak idle looks in a row,
$PollSeconds apart (that also covers a bot's last memory save). Tasks waiting on
the user count as working, as in the waiter; the timeout is what ends a wait that
nobody will answer. Returns $true when idle, $false on timeout.
#>
function Wait-PbAllIdle {
    param([double]$TimeoutMinutes = 120, [int]$PollSeconds = 20, [int]$Streak = 3, [string]$StateDb, [scriptblock]$Log)
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $idleCount = 0
    $last = ''
    while ($true) {
        $state = Get-PbBusyState -StateDb $StateDb
        if ($state -eq 'idle') { $idleCount++ } else { $idleCount = 0 }
        if ($state -ne $last) { & $Log "idle check: $state"; $last = $state }
        if ($idleCount -ge $Streak) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Seconds $PollSeconds
    }
}

# ---------------------------------------------------------------- outcome and report

function New-UpdatesOutcome {
    param(
        [string]$RunId,
        [string]$Mode,
        [string]$Result,
        [string]$Summary,
        [string]$Version,
        [string]$Release,
        [string]$PreviousRelease,
        [string[]]$Steps = @(),
        [bool]$Urgent = $false,
        [string]$ReviewLabel,
        [string]$ReviewReport
    )
    $review = $null
    if ($ReviewLabel) { $review = [ordered]@{ label = $ReviewLabel; reportFile = $ReviewReport } }
    $modeText = 'live'
    if ($Mode -eq 'DryRun') { $modeText = 'dry-run' }
    $nullIfEmpty = { param($v) if ($v) { return [string]$v } return $null }
    return [ordered]@{
        runId           = $RunId
        mode            = $modeText
        result          = $Result
        summary         = $Summary
        version         = (& $nullIfEmpty $Version)
        release         = (& $nullIfEmpty $Release)
        previousRelease = (& $nullIfEmpty $PreviousRelease)
        steps           = @($Steps)
        urgent          = $Urgent
        review          = $review
        finishedAt      = (Get-Date).ToUniversalTime().ToString('o')
        reported        = $false
    }
}

function Save-UpdatesOutcome([string]$RunDir, $Outcome) {
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    $json = $Outcome | ConvertTo-Json -Depth 6
    Set-Content -LiteralPath (Join-Path $RunDir 'outcome.json') -Value $json -Encoding UTF8
    # The next run reads this: a report that could not be posted is re-posted then.
    Set-Content -LiteralPath $UpdatesLastOutcomeFile -Value $json -Encoding UTF8
}

# POSTs the report to the "Morning report" relay routine on loopback. Retries a
# down server (right after a restart) for up to $WaitMinutes.
function Send-UpdatesReport {
    param([string]$Text, [int]$WaitMinutes = 10, [scriptblock]$Log)
    if ($env:PB_UPDATES_NO_REPORT) {
        & $Log 'report not posted: PB_UPDATES_NO_REPORT is set (a test of the refusal paths)'
        return $false
    }
    if (-not (Test-Path -LiteralPath $UpdatesTokenFile -PathType Leaf)) {
        & $Log "no report hook token at $UpdatesTokenFile"
        return $false
    }
    $token = (Get-Content -LiteralPath $UpdatesTokenFile -Raw).Trim()
    if ($Text.Length -gt 7900) { $Text = $Text.Substring(0, 7890) + ' [...]' }
    $body = [System.Text.Encoding]::UTF8.GetBytes((@{ message = $Text } | ConvertTo-Json -Compress))
    $paths = Get-PbPaths -Root dev
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    do {
        $port = 38472
        $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
        if ($runtime -and $runtime.port) { $port = [int]$runtime.port }
        $uri = 'http://127.0.0.1:{0}/api/personal/hooks/{1}' -f $port, $token
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Body $body -ContentType 'application/json' -TimeoutSec 20
            if ($response.StatusCode -eq 202) { return $true }
            & $Log "report hook answered $($response.StatusCode)"
            return $false
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 404) { & $Log 'report hook: 404 (the Morning report routine is paused, deleted or its token changed)'; return $false }
            & $Log "report hook not reachable yet ($status $($_.Exception.Message)); retrying"
            Start-Sleep -Seconds 35
        }
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Write-UpdatesAlert([string]$Text, [string]$RunDir) {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UpdatesUrgotAlerts) | Out-Null
        Add-Content -LiteralPath $UpdatesUrgotAlerts -Value ("- {0} {1} (run: {2})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), (($Text -split "`r?`n")[0]), $RunDir) -Encoding UTF8
    } catch { }
}

# Renders the morning report from the ledger and the outcome (ledger.ts
# report), saves it beside the outcome and posts it. Marks the outcome reported.
function Publish-UpdatesReport {
    param([string]$RunDir, [string]$LedgerPath, [scriptblock]$Log)
    $outcomeFile = Join-Path $RunDir 'outcome.json'
    $nodeExe = Resolve-NodeExe
    $res = Invoke-UpdatesProc -FilePath $nodeExe -ArgList @('--disable-warning=ExperimentalWarning', $UpdatesLedgerCli, '--ledger', $LedgerPath, 'report', '--outcome', $outcomeFile) -WorkingDirectory $UpdatesHome -TimeoutSeconds 120
    $text = $res.Out.Trim()
    if ($res.Code -ne 0 -or -not $text) {
        $outcome = Get-Content -LiteralPath $outcomeFile -Raw | ConvertFrom-Json
        $text = "Nightly update $($outcome.runId): $($outcome.result). $($outcome.summary) (The full report could not be rendered: $($res.Err.Trim()))"
        if ($outcome.urgent) { $text = "${UpdatesUrgentPrefix}: $text" }
    }
    Set-Content -LiteralPath (Join-Path $RunDir 'report.md') -Value $text -Encoding UTF8
    $sent = Send-UpdatesReport -Text $text -Log $Log
    if ($sent) {
        & $Log 'morning report posted to the Updates chats'
        $outcome = Get-Content -LiteralPath $outcomeFile -Raw | ConvertFrom-Json
        $outcome.reported = $true
        Save-UpdatesOutcome -RunDir $RunDir -Outcome $outcome
    } elseif ($env:PB_UPDATES_NO_REPORT) {
        & $Log 'morning report kept in report.md only (PB_UPDATES_NO_REPORT)'
    } else {
        & $Log 'morning report NOT posted; written to the urgot alerts file'
        Write-UpdatesAlert -Text $text -RunDir $RunDir
    }
    return $sent
}
