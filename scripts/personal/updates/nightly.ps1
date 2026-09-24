<#
.SYNOPSIS
The Updates bot's two entry points into the nightly Claude Code update
pipeline: -Step preflight before it changes anything, -Step ship when it is done.

.DESCRIPTION
-Step preflight (a minute or two; the bot waits for it):
  1. the nightly lock (one run at a time; a dead run's lock goes stale), and
     nothing else building or deploying (upstream sync, its probe, build.ps1,
     restart.ps1);
  2. the main checkout is on fix/inline-cards, has no uncommitted tracked
     changes, matches origin, and its tree is exactly what is live;
  3. a database backup (backup.ps1);
  4. -Mode DryRun: a throwaway worktree at HEAD (vp i, .env copied) and a copy
     of the ledger, so a rehearsal changes nothing real.
  Prints one JSON line: ok, workDir, baseSha, ledger, dependencyChangesAllowed.
  When it refuses, it records the outcome, posts the report and prints ok=false.

-Step ship (seconds): checks the lock is this run's and launches
nightly-pipeline.ps1 detached (see updates-common.ps1), which does the gates,
revert-on-red, version bump, push, build, restart, checks, rollback and report.

Windows PowerShell 5.1 compatible.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\nightly.ps1 -Step preflight -RunId 20260925-0400 -Mode Live
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preflight', 'ship')][string]$Step,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z-]+$')][string]$RunId,
    [ValidateSet('Live', 'DryRun')][string]$Mode = 'Live',
    [string]$ReviewLabel,
    [string]$ReviewReport
)

. (Join-Path $PSScriptRoot 'updates-common.ps1')
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$runDir = Get-UpdatesRunDir $RunId
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$logFile = Join-Path $runDir "$Step.log"
$log = {
    param([string]$Text)
    $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    [Console]::Error.WriteLine($line)
}
$paths = Get-PbPaths -Root dev
$repo = $PbRepoRoot
$nodeExe = Resolve-NodeExe
$env:PATH = "$(Join-Path $repo 'node_modules\.bin');$(Split-Path -Parent $nodeExe);$env:PATH"

function Write-Result($Object) {
    # The one line the bot reads, on stdout.
    [Console]::Out.WriteLine(($Object | ConvertTo-Json -Compress -Depth 5))
}

function Remove-UpdatesDryWorktree {
    if (Test-Path -LiteralPath $UpdatesDryWorktree) {
        & $log "removing the old dry-run worktree $UpdatesDryWorktree"
        # Not `git worktree remove`: it fails on pnpm's deep paths and orphans the
        # directory (see upstream-sync.ps1). rmdir unlinks junctions, never follows them.
        [void](Invoke-UpdatesProc -FilePath $env:ComSpec -ArgList @('/c', 'rmdir', '/s', '/q', $UpdatesDryWorktree) -WorkingDirectory $UpdatesHome -TimeoutSeconds 1800)
    }
    [void](Invoke-UpdatesGit -Repo $repo -GitArgs @('worktree', 'prune') -AllowFail)
    if (Test-Path -LiteralPath $UpdatesDryWorktree) { throw "could not remove $UpdatesDryWorktree" }
}

# Re-posts a previous run's report that never reached the chat (server down).
function Send-UnreportedPreviousOutcome {
    if (-not (Test-Path -LiteralPath $UpdatesLastOutcomeFile -PathType Leaf)) { return }
    try {
        $last = Get-Content -LiteralPath $UpdatesLastOutcomeFile -Raw | ConvertFrom-Json
        if ($last.reported -or $last.runId -eq $RunId) { return }
        $lastDir = Get-UpdatesRunDir ([string]$last.runId)
        $report = Join-Path $lastDir 'report.md'
        if (Test-Path -LiteralPath $report) {
            & $log "re-posting run $($last.runId)'s report, which never reached the chat"
            $text = "(Delivered late) " + (Get-Content -LiteralPath $report -Raw)
            if (Send-UpdatesReport -Text $text -WaitMinutes 1 -Log $log) {
                $last.reported = $true
                Set-Content -LiteralPath $UpdatesLastOutcomeFile -Value ($last | ConvertTo-Json -Depth 6) -Encoding UTF8
            }
        }
    } catch {
        & $log "could not re-post the previous report: $($_.Exception.Message)"
    }
}

function Invoke-Preflight {
    & $log "preflight run $RunId ($Mode), checkout $repo"
    Send-UnreportedPreviousOutcome
    $blockers = Get-UpdatesBlockers
    if ($blockers.Count -gt 0) { throw ("something else is building or deploying: " + ($blockers -join '; ')) }
    Enter-UpdatesLock -RunId $RunId -Mode $Mode
    $script:lockTaken = $true

    $branch = Get-UpdatesGitText -Repo $repo -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($branch -ne $UpdatesBranch) { throw "the checkout is on '$branch', not $UpdatesBranch" }
    $dirty = @(Get-UpdatesGitLines -Repo $repo -GitArgs @('status', '--porcelain', '--untracked-files=no'))
    if ($dirty.Count -gt 0) { throw "the checkout has $($dirty.Count) uncommitted change(s) (someone is working in it): $(($dirty | Select-Object -First 5) -join ', ')" }
    [void](Invoke-UpdatesGit -Repo $repo -GitArgs @('fetch', 'origin', $UpdatesBranch))
    $head = Get-UpdatesGitText -Repo $repo -GitArgs @('rev-parse', 'HEAD')
    $origin = Get-UpdatesGitText -Repo $repo -GitArgs @('rev-parse', "origin/$UpdatesBranch")
    if ($head -ne $origin) {
        $ahead = [int](Get-UpdatesGitText -Repo $repo -GitArgs @('rev-list', '--count', "origin/$UpdatesBranch..HEAD"))
        $behind = [int](Get-UpdatesGitText -Repo $repo -GitArgs @('rev-list', '--count', "HEAD..origin/$UpdatesBranch"))
        throw "the checkout is $ahead commit(s) ahead of and $behind behind origin/$UpdatesBranch; push or pull first"
    }
    $state = Read-PbServerState -Paths $paths
    if (-not $state -or -not $state.release) { throw 'Bots is not running (no run\server.json); nothing to update' }
    $liveRelease = [string]$state.release
    if ($liveRelease -match '-dirty-') { throw "the live release $liveRelease was built from uncommitted changes" }
    $sameTree = Invoke-UpdatesGit -Repo $repo -GitArgs @('diff', '--quiet', $liveRelease, 'HEAD', '--') -AllowFail
    if ($sameTree.Code -ne 0) { throw "HEAD has changes that are not live (live release $liveRelease); ship or revert them first" }
    $drive = Get-PSDrive -Name ($repo.Substring(0, 1))
    if ($drive.Free -lt 5GB) { throw "less than 5 GB free on $($drive.Name):" }

    & $log 'database backup ...'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $backup = Invoke-UpdatesProc -FilePath $powershellExe -ArgList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'scripts\personal\backup.ps1')) -WorkingDirectory $repo -TimeoutSeconds 900 -LogPath (Join-Path $runDir 'backup.log')
    if ($backup.Code -ne 0) { throw "backup.ps1 failed (exit $($backup.Code)); log $runDir\backup.log" }
    $backupLine = @($backup.Out -split "`r?`n" | Where-Object { $_ -match '^Backup written' }) | Select-Object -First 1

    $liveExternals = Get-UpdatesReleaseExternals $liveRelease
    $workDir = $repo
    $ledger = $UpdatesLedger
    $dependencyChangesAllowed = ($liveExternals -eq 'copied')
    if ($Mode -eq 'DryRun') {
        Remove-UpdatesDryWorktree
        & $log "creating the dry-run worktree at $UpdatesDryWorktree"
        [void](Invoke-UpdatesGit -Repo $repo -GitArgs @('worktree', 'add', '--detach', '--quiet', $UpdatesDryWorktree, $head))
        $envFile = Join-Path $repo '.env'
        if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination (Join-Path $UpdatesDryWorktree '.env') -Force }
        & $log 'vp i in the dry-run worktree ...'
        $install = Invoke-UpdatesProc -FilePath (Join-Path $repo 'node_modules\.bin\vp.cmd') -ArgList @('i') -WorkingDirectory $UpdatesDryWorktree -TimeoutSeconds 1800 -LogPath (Join-Path $runDir 'dry-install.log')
        if ($install.Code -ne 0) { throw "vp i failed in the dry-run worktree (exit $($install.Code)); log $runDir\dry-install.log" }
        $workDir = $UpdatesDryWorktree
        $ledger = Join-Path $runDir 'proposals.json'
        if (Test-Path -LiteralPath $UpdatesLedger) { Copy-Item -LiteralPath $UpdatesLedger -Destination $ledger -Force }
        # The worktree has its own node_modules: a dependency change there cannot touch the live server.
        $dependencyChangesAllowed = $true
    }

    # Untracked files already there (notes, handoffs): only new ones are the bot's.
    $untracked = @(Get-UpdatesGitLines -Repo $workDir -GitArgs @('ls-files', '--others', '--exclude-standard'))
    $run = [ordered]@{
        untracked                = $untracked
        runId                    = $RunId
        mode                     = $Mode
        repo                     = $repo
        workDir                  = $workDir
        baseSha                  = $head
        ledger                   = $ledger
        liveRelease              = $liveRelease
        liveExternals            = $liveExternals
        dependencyChangesAllowed = $dependencyChangesAllowed
        backup                   = [string]$backupLine
        startedAt                = (Get-Date).ToUniversalTime().ToString('o')
    }
    Set-Content -LiteralPath (Join-Path $runDir 'run.json') -Value ($run | ConvertTo-Json) -Encoding UTF8
    Write-UpdatesLock @{ stage = 'bot' }
    & $log "preflight ok: workDir $workDir, base $($head.Substring(0, 10)), live $liveRelease ($liveExternals)"
    Write-Result ([ordered]@{
            ok                       = $true
            runId                    = $RunId
            mode                     = $Mode
            workDir                  = ($workDir -replace '\\', '/')
            baseSha                  = $head
            ledger                   = ($ledger -replace '\\', '/')
            dependencyChangesAllowed = $dependencyChangesAllowed
            liveRelease              = $liveRelease
        })
}

function Invoke-Ship {
    & $log "ship run $RunId ($Mode)"
    Assert-UpdatesLockOwner -RunId $RunId
    $runFile = Join-Path $runDir 'run.json'
    if (-not (Test-Path -LiteralPath $runFile)) { throw "no preflight record for run $RunId ($runFile)" }
    $script:lockTaken = $true
    $pipelineArgs = @('-RunId', $RunId, '-Mode', $Mode)
    if ($ReviewLabel) { $pipelineArgs += @('-ReviewLabel', $ReviewLabel, '-ReviewReport', $ReviewReport) }
    # The detached process gets the user's default environment, not ours: pass
    # where git lives so it does not depend on the machine PATH.
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) { $pipelineArgs += @('-ToolPath', (Split-Path -Parent $git.Source)) }
    Write-UpdatesLock @{ stage = 'pipeline-launch' }
    $pipelinePid = Start-UpdatesDetached -ScriptPath (Join-Path $PSScriptRoot 'nightly-pipeline.ps1') -ScriptArgs $pipelineArgs -WorkingDirectory $UpdatesHome
    Write-UpdatesLock @{ stage = 'pipeline'; pid = $pipelinePid }
    & $log "pipeline launched detached (pid $pipelinePid); log $runDir\pipeline.log"
    Write-Result ([ordered]@{
            ok          = $true
            runId       = $RunId
            pipelinePid = $pipelinePid
            log         = ((Join-Path $runDir 'pipeline.log') -replace '\\', '/')
            next        = 'The gates, build, restart, checks and any rollback run on their own now; the morning report is posted to the Updates chats afterwards.'
        })
}

$script:lockTaken = $false
try {
    if ($Step -eq 'preflight') { Invoke-Preflight } else { Invoke-Ship }
    exit 0
} catch {
    $reason = $_.Exception.Message
    & $log "$Step refused: $reason"
    $result = 'preflight-blocked'
    if ($Step -eq 'ship') { $result = 'error' }
    $outcome = New-UpdatesOutcome -RunId $RunId -Mode $Mode -Result $result `
        -Summary ("The run stopped at {0}: {1}. Nothing was changed, pushed or restarted." -f $Step, $reason) `
        -Steps @("$Step`: $reason") -ReviewLabel $ReviewLabel -ReviewReport $ReviewReport
    Save-UpdatesOutcome -RunDir $runDir -Outcome $outcome
    $ledgerForReport = $UpdatesLedger
    $runFile = Join-Path $runDir 'run.json'
    if (Test-Path -LiteralPath $runFile) {
        try { $ledgerForReport = [string]((Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json).ledger) } catch { }
    }
    $sent = Publish-UpdatesReport -RunDir $runDir -LedgerPath $ledgerForReport -Log $log
    if ($script:lockTaken) { Exit-UpdatesLock -RunId $RunId }
    if ($Mode -eq 'DryRun' -and $Step -eq 'preflight') {
        try { Remove-UpdatesDryWorktree } catch { & $log "cleanup: $($_.Exception.Message)" }
    }
    Write-Result ([ordered]@{ ok = $false; runId = $RunId; reason = $reason; reported = [bool]$sent })
    exit 1
}
