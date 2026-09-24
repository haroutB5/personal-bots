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
$UpdatesBranch = 'fix/inline-cards'
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
    $patterns = @('scripts[\\/]personal[\\/](build|restart)\.ps1', 'upstream-sync\.ps1', 'run --filter t3 build')
    $procs = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, CommandLine -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
        $line = [string]$proc.CommandLine
        if (-not $line -or [int]$proc.ProcessId -eq $PID) { continue }
        foreach ($pattern in $patterns) {
            if ($line -match $pattern) {
                $blockers += "a build or deploy is running (pid $($proc.ProcessId): $($line.Substring(0, [math]::Min(160, $line.Length))))"
                break
            }
        }
    }
    return , $blockers
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

# ---------------------------------------------------------------- gates

function Get-UpdatesKnownFailures {
    $file = Join-Path $PSScriptRoot '..\sync\known-test-failures.txt'
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    return @(Get-Content -LiteralPath $file | ForEach-Object { $_.Trim() } |
            Where-Object { $_.Length -gt 0 -and -not $_.StartsWith('#') })
}

function Get-UpdatesVitestFailures([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    return @($clean -split "`r?`n" | Where-Object { $_ -match '^\s*FAIL\s+\S+' } |
            ForEach-Object { ($_ -replace '^\s*FAIL\s+', '').Trim() } | Sort-Object -Unique)
}

# The gates the brief names: server personal tests, web personal tests,
# typecheck, lint. perf:check needs the live server, so it runs after the
# restart (nightly-pipeline.ps1). Never an unfiltered `vp test run` in apps\server.
function Get-UpdatesGateList([string]$Root) {
    $tsc = '..\..\node_modules\.bin\tsc.cmd'
    $vp = Join-Path $Root 'node_modules\.bin\vp.cmd'
    return @(
        @{ Name = 'test-server'; Dir = 'apps\server'; File = $vp; Args = @('test', 'run', 'src/personal'); Kind = 'vitest' },
        @{ Name = 'test-web'; Dir = 'apps\web'; File = $vp; Args = @('test', 'run', '--project', 'unit', 'src/features/personal'); Kind = 'vitest' },
        @{ Name = 'typecheck-contracts'; Dir = 'packages\contracts'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-shared'; Dir = 'packages\shared'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-client-runtime'; Dir = 'packages\client-runtime'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-server'; Dir = 'apps\server'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-web'; Dir = 'apps\web'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'lint'; Dir = '.'; File = $vp; Args = @('lint', '--report-unused-disable-directives'); Kind = 'exit' }
    )
}

<#
.SYNOPSIS
Runs every gate; returns the red ones. A vitest FAIL listed in
sync\known-test-failures.txt is ignored; other failing files get one isolated
re-run (timing flakes on this laptop) and count only if a test fails twice.
#>
function Invoke-UpdatesGates {
    param([object[]]$Gates, [string]$Root, [string]$LogDir, [scriptblock]$Log)
    $known = Get-UpdatesKnownFailures
    $red = New-Object System.Collections.Generic.List[string]
    foreach ($gate in $Gates) {
        $dir = Join-Path $Root $gate.Dir
        $logFile = Join-Path $LogDir ('gate-{0}.log' -f $gate.Name)
        & $Log "gate $($gate.Name) ..."
        $res = Invoke-UpdatesProc -FilePath $gate.File -ArgList $gate.Args -WorkingDirectory $dir -TimeoutSeconds 2400 -LogPath $logFile
        if ($gate.Kind -eq 'exit') {
            if ($res.Code -ne 0) { $red.Add("$($gate.Name) exited $($res.Code) (log $logFile)") | Out-Null }
            continue
        }
        if ($res.Code -eq 0) { continue }
        $failures = @(Get-UpdatesVitestFailures -Output ($res.Out + "`n" + $res.Err))
        $unknown = @($failures | Where-Object { $line = $_; -not ($known | Where-Object { $line.Contains($_) }) })
        if ($failures.Count -eq 0) {
            $red.Add("$($gate.Name) exited $($res.Code) with no FAIL lines (crash or timeout; log $logFile)") | Out-Null
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

# ---------------------------------------------------------------- the bot's task

<#
.SYNOPSIS
Waits until the Updates bot has no task still working (read-only SQLite), so
the restart never cuts its turn off. Tasks waiting on the user are not waited
for: nobody answers at 04:00. Returns $true when idle, $false on timeout.
#>
function Wait-UpdatesBotIdle {
    param([int]$TimeoutMinutes = 20, [int]$GraceSeconds = 30, [scriptblock]$Log)
    $paths = Get-PbPaths -Root dev
    $nodeExe = Resolve-NodeExe
    $env:PB_UPDATES_DB = Join-Path $paths.StateDir 'state.sqlite'
    $env:PB_UPDATES_BOT = $UpdatesBotId
    $query = 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.PB_UPDATES_DB,{readOnly:true});db.exec("PRAGMA busy_timeout=5000");const r=db.prepare("SELECT count(*) AS n FROM personal_tasks WHERE bot_id=? AND status IN (''queued'',''running'',''waiting_for_agent'',''rate_limited'')").get(process.env.PB_UPDATES_BOT);console.log(r.n)'
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        $res = Invoke-UpdatesProc -FilePath $nodeExe -ArgList @('--disable-warning=ExperimentalWarning', '-e', $query) -WorkingDirectory $UpdatesHome -TimeoutSeconds 60
        $count = -1
        if ($res.Code -eq 0) { [void][int]::TryParse($res.Out.Trim(), [ref]$count) }
        if ($count -eq 0) {
            & $Log "the Updates bot has no working task; waiting $GraceSeconds s for its memory save"
            Start-Sleep -Seconds $GraceSeconds
            return $true
        }
        & $Log "the Updates bot still has $count working task(s); waiting"
        Start-Sleep -Seconds 15
    }
    return $false
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
    } else {
        & $Log 'morning report NOT posted; written to the urgot alerts file'
        Write-UpdatesAlert -Text $text -RunDir $RunDir
    }
    return $sent
}
