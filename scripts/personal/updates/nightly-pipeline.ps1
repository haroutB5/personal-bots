<#
.SYNOPSIS
The detached half of the nightly Claude Code update run: gates, revert on red,
version bump, push, build, restart, checks, rollback, outcome and report.

.DESCRIPTION
Launched by `nightly.ps1 -Step ship` through WMI, so it lives outside the Bots
server's process tree and survives the restart it performs. Never run it by
hand for a live run; for a rehearsal use the app's "Run now" on the "Claude
Code nightly update" routine, which runs everything below with -Mode DryRun.

Live:
  1. The run's commits (base..HEAD) must leave a clean tree and touch nothing
     the bot may not (.env, secrets, app-version.txt).
  2. Gates: server src/personal, web src/features/personal, typecheck
     (contracts, shared, client-runtime, server, web), lint. Red: every commit
     of the run is reverted with new revert commits and pushed (never reset,
     amend or force); the proposals go back to waiting for approval.
  3. Patch version bump, push, build.ps1 -NoActivate -CopyExternals (every
     nightly release carries its own externals, so a rollback onto it stays
     valid after a later `vp i`). A failed build is reverted like red gates.
  4. Waits until the Updates bot's task has ended, so the restart never cuts
     its turn off.
  5. restart.ps1 -Release <new>, smoke.ps1 (process, local and relay health,
     60 s stability, log scan), /version.txt local and through the relay, and
     perf:check (bots list and one chat open, within budget; one retry).
  6. Any failure: restart.ps1 -Release <previous> (the release that was live),
     smoke it, revert the run's commits and push. If that also fails the
     report is urgent ("Needs attention"): Bots may be down.
  7. The outcome goes to runs\<id>\outcome.json and last-outcome.json (the next
     run re-posts a report that never arrived), the report to the Updates chats.

DryRun (the rehearsal, -Mode DryRun, in a throwaway worktree): steps 1-4 for
real except the push; build.ps1 stages a release without activating it;
instead of the restart, restore-test.ps1 boots the new release on a copy of the
newest backup (deploy rehearsal). Then the rollback path runs for real without
touching the live server: the rollback target is chosen exactly as live,
restore-test.ps1 boots it on a backup copy, and the run's commits are reverted
with real revert commits in the worktree, which must end byte-identical to the
base. The worktree and the rehearsal release are deleted afterwards.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z-]+$')][string]$RunId,
    [ValidateSet('Live', 'DryRun')][string]$Mode = 'Live',
    [string]$ReviewLabel,
    [string]$ReviewReport,
    [string]$ToolPath,
    [int]$WaitMinutes = 20,
    [int]$StableSeconds = 60
)

. (Join-Path $PSScriptRoot 'updates-common.ps1')
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$runDir = Get-UpdatesRunDir $RunId
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$script:RunLogPath = Join-Path $runDir 'pipeline.log'
$log = {
    param([string]$Text)
    Add-Content -LiteralPath $script:RunLogPath -Value ('{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text) -Encoding UTF8
}
$paths = Get-PbPaths -Root dev
$nodeExe = Resolve-NodeExe
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pathParts = @((Join-Path $PbRepoRoot 'node_modules\.bin'), (Split-Path -Parent $nodeExe), (Join-Path $env:LOCALAPPDATA 'vite-plus\bin'))
if ($ToolPath) { $pathParts += $ToolPath }
$env:PATH = (($pathParts + @($env:PATH)) -join ';')

$run = Get-Content -LiteralPath (Join-Path $runDir 'run.json') -Raw | ConvertFrom-Json
$repo = [string]$run.repo
$workDir = [string]$run.workDir
$base = [string]$run.baseSha
$ledger = [string]$run.ledger
$isLive = $Mode -eq 'Live'

$steps = New-Object System.Collections.Generic.List[string]
$script:result = 'error'
$script:summary = ''
$script:version = $null
$script:release = $null
$script:previous = $null
$script:urgent = $false
$script:pushed = $false
$script:deployStarted = $false
$script:noUndo = $false

function Add-Step([string]$Text) { $steps.Add($Text) | Out-Null; & $log "STEP $Text" }

function Invoke-Ledger([string[]]$LedgerArgs) {
    $res = Invoke-UpdatesProc -FilePath $nodeExe -ArgList (@('--disable-warning=ExperimentalWarning', $UpdatesLedgerCli, '--ledger', $ledger, '--run', $RunId) + $LedgerArgs) -WorkingDirectory $UpdatesHome -TimeoutSeconds 120
    if ($res.Code -ne 0) { & $log "ledger $($LedgerArgs -join ' ') failed: $($res.Err.Trim())" }
    return $res
}

function Invoke-PbScript([string]$Name, [string[]]$ScriptArgs, [int]$TimeoutSeconds, [string]$ScriptsRoot = $repo) {
    $logPath = Join-Path $runDir ("{0}-{1}.log" -f [System.IO.Path]::GetFileNameWithoutExtension($Name), (Get-Date -Format 'HHmmss'))
    $res = Invoke-UpdatesProc -FilePath $powershellExe -ArgList (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ScriptsRoot "scripts\personal\$Name")) + $ScriptArgs) `
        -WorkingDirectory $ScriptsRoot -TimeoutSeconds $TimeoutSeconds -LogPath $logPath
    & $log ("{0} {1} exited {2} (log {3})" -f $Name, ($ScriptArgs -join ' '), $res.Code, $logPath)
    return $res
}

function Get-RunCommits {
    return @(Get-UpdatesGitLines -Repo $workDir -GitArgs @('rev-list', '--reverse', "$base..HEAD"))
}

function Push-Run([string]$Why) {
    if (-not $isLive) { Add-Step "push skipped (dry run): $Why"; return $true }
    $push = Invoke-UpdatesGit -Repo $workDir -GitArgs @('push', 'origin', "HEAD:refs/heads/$UpdatesBranch") -AllowFail
    if ($push.Code -ne 0) {
        Add-Step "push rejected ($Why): $($push.Err.Trim())"
        return $false
    }
    Add-Step "pushed to origin/$UpdatesBranch ($Why)"
    return $true
}

# Every commit of the run, newest first, with new revert commits; then push.
function Undo-Run([string]$Reason) {
    $commits = Get-RunCommits
    if ($commits.Count -eq 0) { return }
    $created = Invoke-UpdatesRevert -Repo $workDir -Commits $commits -Reason $Reason
    Add-Step ("reverted {0} commit(s) with {1} revert commit(s): {2}" -f $commits.Count, $created.Count, $Reason)
    if ($isLive) { [void](Invoke-Ledger @('run-reverted', '--reason', $Reason)) }
    [void](Push-Run 'the reverts')
}

function Get-VersionTxt([string]$Origin) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($Origin.TrimEnd('/') + '/version.txt') -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }
        return (ConvertFrom-UpdatesKeyValue ([string]$response.Content))
    } catch {
        return $null
    }
}

function Get-RelayOrigin {
    $state = Read-PbServerState -Paths $paths
    if (-not $state) { return $null }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = (& $nodeExe ([string]$state.binPath) connect status --json --base-dir ([string]$state.baseDir) 2>$null) -join "`n"
    $ErrorActionPreference = $prev
    $start = $raw.IndexOf('{')
    if ($start -lt 0) { return $null }
    try { return [string](($raw.Substring($start) | ConvertFrom-Json).endpointUrl) } catch { return $null }
}

# /version.txt names the new version and release, locally and through the relay.
function Test-ServedVersion([string]$Version, [string]$Release) {
    $ok = $true
    $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
    $local = 'http://127.0.0.1:38472'
    if ($runtime -and $runtime.origin) { $local = [string]$runtime.origin }
    $relay = Get-RelayOrigin
    foreach ($pair in @(@('local', $local), @('relay', $relay))) {
        $name = $pair[0]
        $origin = $pair[1]
        if (-not $origin) { Add-Step "version.txt ${name}: no origin"; $ok = $false; continue }
        $served = $null
        for ($i = 0; $i -lt 6 -and -not $served; $i++) {
            $served = Get-VersionTxt $origin
            if (-not $served) { Start-Sleep -Seconds 10 }
        }
        if ($served -and $served['version'] -eq $Version -and $served['release'] -eq $Release) {
            Add-Step "version.txt $name reads $Version ($Release)"
        } else {
            $seen = 'nothing'
            if ($served) { $seen = "$($served['version']) ($($served['release']))" }
            Add-Step "version.txt $name reads $seen, expected $Version ($Release)"
            $ok = $false
        }
    }
    return $ok
}

function Test-PerfCheck {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $res = Invoke-UpdatesProc -FilePath $nodeExe -ArgList @((Join-Path $repo 'scripts\personal\perf\check.mjs')) -WorkingDirectory $repo -TimeoutSeconds 1200 -LogPath (Join-Path $runDir "perf-check-$attempt.log")
        if ($res.Code -eq 0) { Add-Step "perf:check passed (bots list and a chat open within budget; attempt $attempt)"; return $true }
        & $log "perf:check attempt $attempt exited $($res.Code)"
        Start-Sleep -Seconds 20
    }
    Add-Step "perf:check failed twice (logs $runDir\perf-check-*.log)"
    return $false
}

function Test-LocalHealth {
    try {
        $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
        $origin = 'http://127.0.0.1:38472'
        if ($runtime -and $runtime.origin) { $origin = [string]$runtime.origin }
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($origin.TrimEnd('/') + '/.well-known/t3/environment') -TimeoutSec 15
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Invoke-Pipeline {
    & $log "pipeline run $RunId ($Mode), workDir $workDir, base $base, pid $PID"
    Write-UpdatesLock @{ stage = 'pipeline'; pid = $PID }

    # 1. What the bot left.
    $dirty = @(Get-UpdatesGitLines -Repo $workDir -GitArgs @('status', '--porcelain', '--untracked-files=no'))
    if ($dirty.Count -gt 0) {
        $script:result = 'error'
        $script:summary = "The bot left $($dirty.Count) uncommitted change(s) in $workDir; nothing was gated, pushed or restarted, and the tree was left as it is for a look."
        Add-Step ("uncommitted: " + (($dirty | Select-Object -First 5) -join ', '))
        return
    }
    # A file the bot created but never committed would be built and deployed
    # without being in git: refuse, like uncommitted changes.
    $before = @($run.untracked)
    $newUntracked = @(Get-UpdatesGitLines -Repo $workDir -GitArgs @('ls-files', '--others', '--exclude-standard') |
            Where-Object { $before -notcontains $_ -and $_ -match '^(apps|packages|scripts)/' })
    if ($newUntracked.Count -gt 0) {
        $script:result = 'error'
        $script:summary = "The bot left $($newUntracked.Count) new file(s) it never committed ($(($newUntracked | Select-Object -First 5) -join ', ')); nothing was gated, pushed or restarted."
        Add-Step ("untracked: " + (($newUntracked | Select-Object -First 5) -join ', '))
        return
    }
    $commits = Get-RunCommits
    if ($commits.Count -eq 0) {
        $script:result = 'nothing-applied'
        $script:summary = 'Nothing was applied this time, so nothing was built or restarted.'
        Add-Step 'no commits: no gates, build or restart needed'
        return
    }
    $recorded = @()
    $appliedNow = Invoke-Ledger @('run-commits')
    if ($appliedNow.Code -eq 0) {
        try { $recorded = @(($appliedNow.Out | ConvertFrom-Json) | ForEach-Object { $_.commits }) } catch { $recorded = @() }
    }
    $foreign = Get-UpdatesForeignCommits -RangeCommits $commits -RecordedCommits $recorded
    if ($foreign.Count -gt 0) {
        # Never gate, ship or revert work that is not provably this run's.
        $script:result = 'error'
        $script:summary = "$($foreign.Count) commit(s) since the run started are not recorded by any of its proposals ($((($foreign | ForEach-Object { $_.Substring(0, 10) }) -join ', '))): someone else committed in the checkout, or the bot did not record them. Nothing was gated, pushed, reverted or restarted; the checkout needs a look."
        Add-Step ("unrecorded commits: " + (($foreign | ForEach-Object { $_.Substring(0, 10) }) -join ', '))
        $script:noUndo = $true
        return
    }
    Add-Step ("{0} commit(s) from the bot: {1}" -f $commits.Count, (($commits | ForEach-Object { $_.Substring(0, 10) }) -join ', '))
    $changed = @(Get-UpdatesGitLines -Repo $workDir -GitArgs @('diff', '--name-only', "$base..HEAD"))
    $forbidden = Get-UpdatesForbiddenPaths -ChangedPaths $changed
    if ($forbidden.Count -gt 0) {
        Undo-Run "the run touched files it must not ($($forbidden -join ', '))"
        $script:result = 'gates-red'
        $script:summary = "The run's commits touched files the bot must never change ($($forbidden -join ', ')); they were reverted."
        return
    }

    # 2. Gates.
    $gates = Get-UpdatesGateList -Root $workDir
    $red = Invoke-UpdatesGates -Gates $gates -Root $workDir -LogDir $runDir -Log $log
    if ($red.Count -gt 0) {
        Add-Step ("gates red: " + ($red -join ' | '))
        Undo-Run ("gates red: " + (($red | ForEach-Object { ($_ -split ' ')[0] }) -join ', '))
        $script:result = 'gates-red'
        $script:summary = "The gates were red after the bot's changes, so every change of this run was reverted (new revert commits, pushed). Nothing was built or restarted."
        return
    }
    Add-Step 'gates green: server src/personal, web src/features/personal, typecheck (contracts, shared, client-runtime, server, web), lint'

    # 3. Version, push, build.
    $versionFile = Join-Path $workDir 'scripts\personal\app-version.txt'
    $oldVersion = (Get-Content -LiteralPath $versionFile -First 1).Trim()
    $script:version = Get-UpdatesNextPatchVersion $oldVersion
    Set-Content -LiteralPath $versionFile -Value $script:version -Encoding ASCII
    $ids = @()
    $applied = Invoke-Ledger @('run-commits')
    if ($applied.Code -eq 0) { try { $ids = @(($applied.Out | ConvertFrom-Json) | ForEach-Object { $_.id }) } catch { } }
    $idText = ''
    if ($ids.Count -gt 0) { $idText = " ($($ids -join ', '))" }
    [void](Invoke-UpdatesGit -Repo $workDir -GitArgs @('add', 'scripts/personal/app-version.txt'))
    [void](Invoke-UpdatesGit -Repo $workDir -GitArgs ($UpdatesGitIdentity + @('commit', '-m', "release $($script:version): nightly Claude Code update$idText", '-m', "Automated by scripts/personal/updates/nightly-pipeline.ps1 (run $RunId).")))
    Add-Step "version $oldVersion -> $($script:version)"
    if (-not (Push-Run "release $($script:version)")) {
        $script:result = 'push-rejected'
        $script:summary = "Gates were green but origin/$UpdatesBranch moved, so the push was rejected (never forced). Nothing was built or restarted; the commits are local in $workDir for a manual merge."
        return
    }
    $script:pushed = $isLive
    $build = Invoke-PbScript -Name 'build.ps1' -ScriptArgs @('-NoActivate', '-CopyExternals') -TimeoutSeconds 2400 -ScriptsRoot $workDir
    $script:release = Get-UpdatesGitText -Repo $workDir -GitArgs @('rev-parse', '--short=12', 'HEAD')
    $releaseDir = Join-Path $paths.ReleasesDir $script:release
    if ($build.Code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $releaseDir 'dist\bin.mjs'))) {
        Add-Step "build.ps1 failed (exit $($build.Code))"
        Undo-Run 'the build failed'
        $script:result = 'build-failed'
        $script:summary = 'The build failed, so every change of this run (and the version bump) was reverted. Nothing was restarted.'
        $script:release = $null
        return
    }
    Add-Step "built release $($script:release) with its own externals (not active yet)"

    # 4. Let the bot finish its turn before anything restarts.
    if (Wait-UpdatesBotIdle -TimeoutMinutes $WaitMinutes -Log $log) {
        Add-Step 'the Updates bot had finished its turn'
    } else {
        Add-Step "the Updates bot was still working after $WaitMinutes min; continuing"
    }
    $state = Read-PbServerState -Paths $paths
    $running = $null
    if ($state) { $running = [string]$state.release }
    $script:previous = Select-UpdatesRollbackTarget -RunningRelease $running -PreflightRelease ([string]$run.liveRelease) -NewRelease $script:release
    if (-not $script:previous) { throw 'no release to roll back to; not deploying without one' }

    if (-not $isLive) { Invoke-Rehearsal; return }

    # 5. Deploy and verify.
    $logPath = Join-Path $paths.LogsDir ('server-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
    $offset = 0
    if (Test-Path -LiteralPath $logPath) { $offset = (Get-Item -LiteralPath $logPath).Length }
    $script:deployStarted = $true
    $restart = Invoke-PbScript -Name 'restart.ps1' -ScriptArgs @('-Release', $script:release) -TimeoutSeconds 300
    $ok = $restart.Code -eq 0
    if ($ok) {
        Add-Step "restarted on $($script:release)"
        $smoke = Invoke-PbScript -Name 'smoke.ps1' -ScriptArgs @('-ExpectRelease', $script:release, '-StableSeconds', [string]$StableSeconds, '-LogFile', $logPath, '-LogFromByte', [string]$offset) -TimeoutSeconds 900
        $ok = $smoke.Code -eq 0
        if ($ok) {
            Add-Step "smoke passed (process, local + relay health, $StableSeconds s stable, clean log)"
        } else {
            Add-Step ("smoke FAILED: " + ((($smoke.Out -split "`r?`n") | Where-Object { $_ -match 'FAIL' }) -join ' | '))
        }
    } else {
        Add-Step "restart.ps1 -Release $($script:release) FAILED (exit $($restart.Code))"
    }
    if ($ok) { $ok = Test-ServedVersion -Version $script:version -Release $script:release }
    if ($ok) { $ok = Test-PerfCheck }
    if ($ok) {
        [void](Invoke-Ledger @('run-shipped', '--version', $script:version))
        $script:result = 'shipped'
        $script:summary = "$($script:version) is live: gates green, restart, smoke, version check (local and relay) and perf:check all passed. Rollback target kept: $($script:previous)."
        return
    }

    # 6. Roll back.
    & $log "rolling back to $($script:previous)"
    $back = Invoke-PbScript -Name 'restart.ps1' -ScriptArgs @('-Release', $script:previous) -TimeoutSeconds 300
    $backSmoke = $null
    if ($back.Code -eq 0) {
        $backSmoke = Invoke-PbScript -Name 'smoke.ps1' -ScriptArgs @('-ExpectRelease', $script:previous, '-StableSeconds', [string]$StableSeconds) -TimeoutSeconds 900
    }
    $restoreHelp = "The database was not touched; if it ever needs restoring, the backup from this run's preflight is listed in $runDir\run.json."
    if ($back.Code -eq 0 -and $backSmoke.Code -eq 0) {
        Add-Step "rolled back: $($script:previous) is live again and passed its smoke"
        Undo-Run "the new release $($script:release) failed its checks"
        $script:result = 'rolled-back'
        $script:summary = "$($script:version) failed its checks after the restart, so Bots is back on $($script:previous) and the run's changes were reverted. $restoreHelp"
        return
    }
    Add-Step "ROLLBACK FAILED: restart.ps1 -Release $($script:previous) exited $($back.Code)"
    Undo-Run "the new release $($script:release) failed its checks and the rollback failed"
    $script:result = 'down'
    $script:urgent = $true
    $script:summary = "$($script:version) failed its checks and the rollback to $($script:previous) did not come up either. Bots may be down: run scripts\personal\status.ps1 and restart.ps1 -Release $($script:previous). $restoreHelp"
}

# The DryRun half of steps 5-6: boot both releases on backup copies, and
# revert for real in the worktree. The live server is never touched.
function Invoke-Rehearsal {
    $rehearsal = Invoke-PbScript -Name 'restore-test.ps1' -ScriptArgs @('-Release', $script:release, '-Seconds', '20') -TimeoutSeconds 600
    $clientVersion = Join-Path (Join-Path $paths.ReleasesDir $script:release) 'dist\client\version.txt'
    $staged = $null
    if (Test-Path -LiteralPath $clientVersion) { $staged = ConvertFrom-UpdatesKeyValue ((Get-Content -LiteralPath $clientVersion) -join "`n") }
    $deployOk = ($rehearsal.Code -eq 0)
    if ($deployOk) {
        Add-Step "deploy rehearsal: $($script:release) boots on a copy of the newest backup (restore-test.ps1)"
    } else {
        Add-Step "deploy rehearsal FAILED: $($script:release) did not boot on a backup copy"
    }
    if ($staged -and $staged['version'] -eq $script:version -and $staged['release'] -eq $script:release) {
        Add-Step "its version.txt reads $($script:version) ($($script:release))"
    } else {
        Add-Step "its version.txt does not read $($script:version)"
        $deployOk = $false
    }
    [void](Invoke-Ledger @('run-shipped', '--version', $script:version))

    # The rollback path, for real except the restart.
    $back = Invoke-PbScript -Name 'restore-test.ps1' -ScriptArgs @('-Release', $script:previous, '-Seconds', '20') -TimeoutSeconds 600
    $rollbackOk = ($back.Code -eq 0)
    if ($rollbackOk) {
        Add-Step "rollback rehearsal: target $($script:previous) (the live release) boots on a backup copy"
    } else {
        Add-Step "rollback rehearsal FAILED: $($script:previous) did not boot on a backup copy"
    }
    $commits = Get-RunCommits
    $created = Invoke-UpdatesRevert -Repo $workDir -Commits $commits -Reason 'rollback rehearsal'
    $same = Invoke-UpdatesGit -Repo $workDir -GitArgs @('diff', '--quiet', $base, 'HEAD', '--') -AllowFail
    if ($same.Code -eq 0) {
        Add-Step ("rollback rehearsal: {0} commit(s) reverted with {1} revert commit(s); the worktree is identical to the base again" -f $commits.Count, $created.Count)
    } else {
        Add-Step 'rollback rehearsal: the reverts did NOT restore the base tree'
        $rollbackOk = $false
    }
    Add-Step "not pushed, not restarted, not activated: this was a rehearsal"
    $script:result = 'dry-run'
    if ($deployOk -and $rollbackOk) {
        $script:summary = "Would ship $($script:version): gates green, the build boots, and the rollback path works."
    } else {
        $script:summary = "The rehearsal found a problem (see the pipeline steps); a live run would have rolled back or stopped here."
    }
}

function Remove-RehearsalLeftovers {
    if ($isLive) { return }
    if ($script:release) {
        $current = ''
        if (Test-Path -LiteralPath $paths.CurrentFile) { $current = (Get-Content -LiteralPath $paths.CurrentFile -Raw).Trim() }
        $state = Read-PbServerState -Paths $paths
        $live = ''
        if ($state) { $live = [string]$state.release }
        $dir = Join-Path $paths.ReleasesDir $script:release
        if ($script:release -ne $current -and $script:release -ne $live -and (Test-Path -LiteralPath $dir)) {
            if (Remove-PbReleaseDirectory -Path $dir) { & $log "removed the rehearsal release $dir" } else { & $log "could not remove $dir" }
        }
    }
    if (Test-Path -LiteralPath $UpdatesDryWorktree) {
        [void](Invoke-UpdatesProc -FilePath $env:ComSpec -ArgList @('/c', 'rmdir', '/s', '/q', $UpdatesDryWorktree) -WorkingDirectory $UpdatesHome -TimeoutSeconds 1800)
        [void](Invoke-UpdatesGit -Repo $repo -GitArgs @('worktree', 'prune') -AllowFail)
        & $log "removed the dry-run worktree (still there: $(Test-Path -LiteralPath $UpdatesDryWorktree))"
    }
}

try {
    Invoke-Pipeline
} catch {
    $detail = $_.Exception.Message
    & $log "ERROR: $detail"
    Add-Step "stopped on an error: $detail"
    $script:result = 'error'
    $recovery = ''
    if ($isLive -and -not $script:noUndo) {
        # Leave the checkout matching what is live, so tonight's error does not
        # block tomorrow's preflight: back onto the previous release if the
        # deploy had started, then revert the run's commits (new commits, pushed).
        try {
            if ($script:deployStarted -and $script:previous) {
                $back = Invoke-PbScript -Name 'restart.ps1' -ScriptArgs @('-Release', $script:previous) -TimeoutSeconds 300
                Add-Step "after the error: restart.ps1 -Release $($script:previous) exited $($back.Code)"
                $recovery = " Bots was put back on $($script:previous)."
            }
            if ((Get-RunCommits).Count -gt 0) {
                Undo-Run "the pipeline stopped on an error: $detail"
                $recovery += " The run's commits were reverted."
            }
        } catch {
            Add-Step "recovery after the error failed: $($_.Exception.Message)"
            $recovery += ' Recovery failed: the checkout needs a look.'
        }
    }
    $healthy = Test-LocalHealth
    $script:urgent = $isLive -and -not $healthy
    $script:summary = "The pipeline stopped on an error: $detail.$recovery Bots is $(if ($healthy) { 'up' } else { 'NOT answering' }). Log: $($script:RunLogPath)"
} finally {
    try {
        $outcome = New-UpdatesOutcome -RunId $RunId -Mode $Mode -Result $script:result -Summary $script:summary `
            -Version $script:version -Release $script:release -PreviousRelease $script:previous -Steps $steps.ToArray() `
            -Urgent $script:urgent -ReviewLabel $ReviewLabel -ReviewReport $ReviewReport
        Save-UpdatesOutcome -RunDir $runDir -Outcome $outcome
        [void](Publish-UpdatesReport -RunDir $runDir -LedgerPath $ledger -Log $log)
    } catch {
        & $log "could not record or post the outcome: $($_.Exception.Message)"
    }
    try { Remove-RehearsalLeftovers } catch { & $log "cleanup: $($_.Exception.Message)" }
    Exit-UpdatesLock -RunId $RunId
    & $log "pipeline done: $($script:result)"
}
