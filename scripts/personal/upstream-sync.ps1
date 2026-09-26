<#
.SYNOPSIS
Weekly upstream sync: merges pingdotgg/t3code main into personal-bots/main,
gates, builds, rehearses the migrations, deploys, and rolls back on a failed
smoke. Fully automatic (the owner's decision, 2026-09-15).

.DESCRIPTION
A deterministic script owns every step that can hurt: fetch, merge, gates,
build, deploy, rollback, push and notify. An LLM is called only for judgment:
the triage (claude -p, read-only) and conflict / red-gate repair (codex exec,
fallback claude -p), inside this sync worktree, with no push or deploy tools.
The script re-runs every gate itself; it never trusts an agent's claim.

Policy:
- Fixes and improvements ship with no question.
- Upstream changes that need a product decision from the owner (the triage's
  `decisions`) are held back: reverted after the merge (or kept on our side by
  the resolve agent), recorded in scripts\personal\sync\held-upstream.json, and
  the owner gets a short decision request. Everything else still ships.
- Stop without deploying on: red gates after one repair round, a merge the
  triage marks needs_judgment, a non-additive or modified upstream migration,
  too many commits/conflicts, a moved main, or a failed build/rehearsal.
- Deploy when every gate passes; a failed smoke rolls back to the previous
  release (binary only; the database is never restored automatically).

-Mode Auto     deploy + push on green (the scheduled default).
-Mode DryRun   stop after build + rehearsal; notify "ready to ship".
-Mode Probe    nightly early warning. Pure script, no LLM, nothing that ships.
-PreflightOnly steps 0-1 only: read-only checks and what a run would do.

Probe answers one question every morning: "would this Saturday's sync hurt?"
It fetches, dry-merges into a throwaway detached worktree under
%USERPROFILE%\.personal-bots\upstream-sync\probe-scratch, and reports how many
upstream commits are pending, whether the merge is clean and, when it is not,
which files conflict. A clean merge that touches our build also gets the two
fast test gates (apps\server src\personal, apps\web src\features\personal);
nothing else - no typecheck sweep, no install in the sync worktree, no build,
no migration rehearsal, no deploy, no push, no held-upstream.json, no agent.
It never touches state.json, the sync branch, the sync worktree or the main
checkout, and it creates no branch, tag, stash or other ref. Its own memory
lives in probe-state.json and its log in probe.log, both beside state.json.
It is quiet on purpose: a clean probe logs one line and sends nothing. A
notification means a conflict, a real (non-whitelisted) gate failure, or a
backlog big enough that the Saturday run would refuse it.

Auto and DryRun run from the sync worktree (default
C:\Claude\AI\personal-bots-sync), never from the main checkout. Probe may run
from either, because it is read-only towards the checkout it runs from; that
matters, since the sync worktree is often parked mid-merge after a stopped
sync, which is exactly when the warning is worth the most. It fingerprints
every worktree before and after and logs whether each one is untouched. Runtime state, logs and the notify token live in
%USERPROFILE%\.personal-bots\upstream-sync (never in git).
Windows PowerShell 5.1 compatible.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\upstream-sync.ps1 -PreflightOnly

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\upstream-sync.ps1 -Mode Probe
#>
[CmdletBinding()]
param(
    [ValidateSet('Auto', 'DryRun', 'Probe')][string]$Mode = 'Auto',
    [switch]$Force,
    [switch]$PreflightOnly,
    [string]$MainRepo = 'C:\Claude\AI\personal-bots',
    [string]$Node,
    # -Mode Probe only: notify when this many upstream commits are pending, and
    # repeat an unchanged finding at most once every this many days.
    [int]$ProbeBacklogWarn = 250,
    [int]$ProbeRemindDays = 7,
    # -Mode Probe only: probe a specific upstream commit instead of
    # upstream/main. Answers "would we be clean if we stopped here?" and is how
    # the clean-merge path is rehearsed without waiting for upstream to be
    # mergeable. Changes nothing else about the run.
    [string]$ProbeUpstreamRef
)

. (Join-Path $PSScriptRoot 'common.ps1')
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$SyncRepo = $PbRepoRoot
$SyncDir = Join-Path $PSScriptRoot 'sync'
$SyncHome = Join-Path $PbHome 'upstream-sync'
$StateFile = Join-Path $SyncHome 'state.json'
$LockFile = Join-Path $SyncHome 'lock'
# Probe keeps every piece of its own state apart from the Saturday run's, so a
# probe can never move what Auto reads: its own lock, log, state file and
# scratch worktree. state.json and held-upstream.json are Auto's alone.
$ProbeLockFile = Join-Path $SyncHome 'probe-lock'
$ProbeStateFile = Join-Path $SyncHome 'probe-state.json'
$ProbeLogFile = Join-Path $SyncHome 'probe.log'
$ProbeScratch = Join-Path $SyncHome 'probe-scratch'
$HookTokenFile = Join-Path $SyncHome 'hook-token'
$UrgotAlerts = 'C:\Claude\AI\urgot\data\alerts\personal-bots-sync.md'
$SchemaFile = Join-Path $SyncDir 'verdict.schema.json'
$HeldFile = Join-Path $SyncDir 'held-upstream.json'
$KnownFailuresFile = Join-Path $SyncDir 'known-test-failures.txt'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir = Join-Path (Join-Path $SyncHome 'runs') $Stamp
$OriginMain = 'origin/personal-bots/main'
$UpstreamMain = 'upstream/main'
$MaxCommits = 400
$MaxConflicts = 15
$AgentTimeoutSeconds = 45 * 60
$RelevantPaths = @(
    'apps/server/', 'apps/web/', 'packages/contracts/', 'packages/shared/', 'packages/client-runtime/',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/', 'vite.config.ts', 'scripts/lib/'
)
$paths = Get-PbPaths -Root dev
$nodeExe = Resolve-NodeExe -Node $Node
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$env:PATH = "$(Join-Path $SyncRepo 'node_modules\.bin');$(Split-Path -Parent $nodeExe);$env:PATH"

$script:LogToFile = $false
$script:ProbeLog = $null
$script:ProbeBefore = $null
$script:StopResult = $null
$script:StopMessage = $null
$script:Triage = $null

# ---------------------------------------------------------------- helpers

function Write-SyncLog([string]$Text) {
    $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text
    Write-Host $line
    if ($script:LogToFile) { Add-Content -LiteralPath (Join-Path $RunDir 'sync.log') -Value $line -Encoding UTF8 }
    if ($script:ProbeLog) { Add-Content -LiteralPath $script:ProbeLog -Value $line -Encoding UTF8 }
}

function Stop-Sync([string]$Result, [string]$Message) {
    $script:StopResult = $Result
    $script:StopMessage = $Message
    throw "SYNC-STOP: $Result"
}

# Quotes one argument by the Windows argv rules (CommandLineToArgvW), so long
# prompts, JSON and quotes reach native programs intact (PS 5.1 does not escape).
function ConvertTo-WinArg([string]$Value) {
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

function Invoke-Proc {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgList = @(),
        [string]$WorkingDirectory = $SyncRepo,
        [string]$StdinText,
        [int]$TimeoutSeconds = 3600,
        [string]$LogPath
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (@($ArgList | ForEach-Object { ConvertTo-WinArg ([string]$_) }) -join ' ')
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
    if ($StdinText) {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($StdinText)
        $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    }
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

function Invoke-Git {
    param([string[]]$GitArgs, [switch]$AllowFail, [string]$Repo = $SyncRepo)
    $res = Invoke-Proc -FilePath 'git' -ArgList (@('-C', $Repo) + $GitArgs) -WorkingDirectory $Repo -TimeoutSeconds 1800
    if ($res.Code -ne 0 -and -not $AllowFail) {
        throw ("git {0} failed ({1}): {2}" -f ($GitArgs -join ' '), $res.Code, $res.Err.Trim())
    }
    return $res
}

function Get-GitText {
    param([string[]]$GitArgs, [string]$Repo = $SyncRepo)
    return (Invoke-Git -GitArgs $GitArgs -Repo $Repo).Out.Trim()
}

function Get-GitLines {
    param([string[]]$GitArgs, [string]$Repo = $SyncRepo)
    $text = (Invoke-Git -GitArgs $GitArgs -Repo $Repo).Out
    return @($text -split "`r?`n" | Where-Object { $_.Length -gt 0 })
}

function Read-SyncState {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Save-SyncState([hashtable]$Changes) {
    $state = [ordered]@{
        lastSyncedUpstream        = $null
        lastRunAt                 = $null
        lastResult                = $null
        lastRelease               = $null
        previousRelease           = $null
        consecutivePreflightSkips = 0
        mode                      = $Mode
        lastRunDir                = $null
    }
    $old = Read-SyncState
    if ($old) { foreach ($prop in $old.PSObject.Properties) { $state[$prop.Name] = $prop.Value } }
    foreach ($key in $Changes.Keys) { $state[$key] = $Changes[$key] }
    $state.lastRunAt = (Get-Date).ToUniversalTime().ToString('o')
    $state.mode = $Mode
    $state.lastRunDir = $RunDir
    Set-Content -LiteralPath $StateFile -Value ($state | ConvertTo-Json -Depth 5) -Encoding UTF8
}

function Get-LiveRelease {
    $state = Read-PbServerState -Paths $paths
    if ($state -and $state.release) { return [string]$state.release }
    return $null
}

function Get-RuntimePort {
    $runtime = Read-PbRuntimeState -BaseDir $paths.BaseDir
    if ($runtime -and $runtime.port) { return [int]$runtime.port }
    return 38472
}

function Show-Toast([string]$Title, [string]$Text) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Warning
        $icon.Visible = $true
        $icon.ShowBalloonTip(15000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Seconds 16
        $icon.Dispose()
    } catch { }
}

# v1 notify path: POST the text to the "Sync reports" bot's event routine
# (loopback only). The bot repeats it in its chat and the routine_result push
# reaches the phone. Returns $true on 202.
function Send-HookMessage([string]$Message) {
    if (-not (Test-Path -LiteralPath $HookTokenFile -PathType Leaf)) { return $false }
    $token = (Get-Content -LiteralPath $HookTokenFile -Raw).Trim()
    if (-not $token) { return $false }
    if ($Message.Length -gt 3000) { $Message = $Message.Substring(0, 2990) + ' [...]' }
    $body = [System.Text.Encoding]::UTF8.GetBytes((@{ message = $Message } | ConvertTo-Json -Compress))
    $uri = 'http://127.0.0.1:{0}/api/personal/hooks/{1}' -f (Get-RuntimePort), $token
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Body $body -ContentType 'application/json' -TimeoutSec 20
            if ($response.StatusCode -eq 202) { return $true }
            return $false
        } catch {
            $status = $null
            $wait = 35
            if ($_.Exception.Response) {
                $status = [int]$_.Exception.Response.StatusCode
                $retryAfter = $_.Exception.Response.Headers['Retry-After']
                if ($retryAfter) { $wait = [math]::Min(60, [int]$retryAfter + 1) }
            }
            if ($status -ne 429) { return $false }
            Start-Sleep -Seconds $wait
        }
    }
    return $false
}

function Send-Notify([string]$Message, [switch]$Alert) {
    Write-SyncLog "NOTIFY: $Message"
    if ($script:LogToFile) { Set-Content -LiteralPath (Join-Path $RunDir 'summary.md') -Value $Message -Encoding UTF8 }
    $sent = $false
    if (-not $Alert) { $sent = Send-HookMessage -Message $Message }
    if (-not $sent) {
        # Fallback when the server is down or the routine is not set up:
        # ALERT.md in the run, the orchestrator's alert file (surfaced in its
        # greeting digest), and a Windows toast. Never Telegram.
        if ($script:LogToFile) { Set-Content -LiteralPath (Join-Path $RunDir 'ALERT.md') -Value $Message -Encoding UTF8 }
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UrgotAlerts) | Out-Null
            Add-Content -LiteralPath $UrgotAlerts -Value ("- {0} {1} (run: {2})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), ($Message -replace "`r?`n", ' '), $RunDir) -Encoding UTF8
        } catch { }
        $short = $Message
        if ($short.Length -gt 240) { $short = $short.Substring(0, 237) + '...' }
        Show-Toast -Title 'Bots upstream sync' -Text $short
    }
}

function Get-KnownFailures {
    if (-not (Test-Path -LiteralPath $KnownFailuresFile)) { return @() }
    return @(Get-Content -LiteralPath $KnownFailuresFile | ForEach-Object { $_.Trim() } |
            Where-Object { $_.Length -gt 0 -and -not $_.StartsWith('#') })
}

function Get-VitestFailures([string]$Output) {
    $clean = $Output -replace "\x1b\[[0-9;]*m", ''
    $lines = @($clean -split "`r?`n" | Where-Object { $_ -match '^\s*FAIL\s+\S+' } |
            ForEach-Object { ($_ -replace '^\s*FAIL\s+', '').Trim() } | Sort-Object -Unique)
    return $lines
}

# ---------------------------------------------------------------- gates

function Get-GateList([string]$Base, [string]$New) {
    $serverTests = @('src/personal', 'src/mcp/toolkits', 'src/provider', 'src/persistence',
        'src/orchestration/Layers/ProviderCommandReactor.test.ts')
    $touched = @()
    if ($Base -and $New) {
        $touched = @(Get-GitLines -GitArgs @('diff', '--name-only', $Base, $New, '--',
                'apps/server/src/orchestration', 'apps/server/src/usage', 'apps/server/src/cli', 'apps/server/src/project') |
                Where-Object { $_ -match '\.test\.ts$' } | ForEach-Object { $_.Substring('apps/server/'.Length) })
    }
    if ($touched.Count -gt 40) {
        $serverTests += @('src/orchestration', 'src/usage', 'src/cli', 'src/project')
    } else {
        $serverTests += $touched
    }
    $serverTests = @($serverTests | Sort-Object -Unique)
    $webTests = @('src/features/personal', 'src/authBootstrap.test.ts', 'src/lib/attachmentUploadQueue.test.ts')
    $tsc = '..\..\node_modules\.bin\tsc.cmd'
    $vp = Join-Path $SyncRepo 'node_modules\.bin\vp.cmd'
    return @(
        @{ Name = 'typecheck-contracts'; Dir = 'packages\contracts'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-shared'; Dir = 'packages\shared'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-client-runtime'; Dir = 'packages\client-runtime'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-server'; Dir = 'apps\server'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        @{ Name = 'typecheck-web'; Dir = 'apps\web'; File = $tsc; Args = @('--noEmit'); Kind = 'exit' },
        # Never an unfiltered `vp test run` in apps\server: it wedges for 15+ minutes.
        @{ Name = 'test-server'; Dir = 'apps\server'; File = $vp; Args = (@('test', 'run') + $serverTests); Kind = 'vitest' },
        @{ Name = 'test-web'; Dir = 'apps\web'; File = $vp; Args = (@('test', 'run', '--project', 'unit') + $webTests); Kind = 'vitest' },
        @{ Name = 'test-root'; Dir = '.'; File = $vp; Args = @('test', 'run', 'scripts/lib/cli-external-packages.test.ts'); Kind = 'vitest' }
    )
}

# Runs every gate. A vitest FAIL that matches known-test-failures.txt is
# ignored; other failing files get one isolated re-run (timing flakes on this
# laptop), and only failures that repeat count. Returns the red descriptions.
function Invoke-Gates {
    param(
        [object[]]$Gates,
        [string]$Label,
        # Probe passes its throwaway scratch worktree and its own log directory;
        # every other caller gates the sync worktree, as before.
        [string]$Root = $SyncRepo,
        [string]$LogDir = $RunDir
    )
    $known = Get-KnownFailures
    $red = New-Object System.Collections.Generic.List[string]
    foreach ($gate in $Gates) {
        $dir = Join-Path $Root $gate.Dir
        $log = Join-Path $LogDir ('gate-{0}-{1}.log' -f $Label, $gate.Name)
        Write-SyncLog "gate $($gate.Name) ..."
        $res = Invoke-Proc -FilePath $gate.File -ArgList $gate.Args -WorkingDirectory $dir -TimeoutSeconds 2400 -LogPath $log
        if ($gate.Kind -eq 'exit') {
            if ($res.Code -ne 0) { $red.Add("$($gate.Name) exited $($res.Code) (log $log)") | Out-Null }
            continue
        }
        if ($res.Code -eq 0) { continue }
        $failures = @(Get-VitestFailures -Output ($res.Out + "`n" + $res.Err))
        $unknown = @($failures | Where-Object { $line = $_; -not ($known | Where-Object { $line.Contains($_) }) })
        if ($failures.Count -eq 0) {
            $red.Add("$($gate.Name) exited $($res.Code) with no FAIL lines (crash or timeout; log $log)") | Out-Null
            continue
        }
        if ($unknown.Count -eq 0) {
            Write-SyncLog "gate $($gate.Name): only known pre-existing failures"
            continue
        }
        $files = @($unknown | ForEach-Object { ($_ -split '\s+>\s+')[0] } | Sort-Object -Unique)
        Write-SyncLog "gate $($gate.Name): re-running $($files.Count) failing file(s) once"
        $rerunLog = Join-Path $LogDir ('gate-{0}-{1}-rerun.log' -f $Label, $gate.Name)
        $rerunArgs = @('test', 'run')
        if ($gate.Args -contains '--project') { $rerunArgs += @('--project', 'unit') }
        $rerun = Invoke-Proc -FilePath $gate.File -ArgList ($rerunArgs + $files) -WorkingDirectory $dir -TimeoutSeconds 1800 -LogPath $rerunLog
        if ($rerun.Code -eq 0) {
            Write-SyncLog "gate $($gate.Name): passed on re-run (flaky: $($unknown -join '; '))"
            continue
        }
        # Only a test that fails in BOTH runs counts. ProviderRuntimeIngestion's
        # 2 s poll deadline flakes a different handful of tests per run on this
        # laptop (4-5 of 67 on pre-merge main too, 2026-09-15), so a whole-file
        # re-run is never fully green; a real regression repeats.
        $rerunFailures = @(Get-VitestFailures -Output ($rerun.Out + "`n" + $rerun.Err))
        $repeated = @($rerunFailures | Where-Object { $unknown -contains $_ })
        if ($repeated.Count -gt 0) {
            $red.Add("$($gate.Name): $($repeated -join '; ') (log $rerunLog)") | Out-Null
        } elseif ($rerunFailures.Count -eq 0) {
            $red.Add("$($gate.Name) re-run exited $($rerun.Code) with no FAIL lines (log $rerunLog)") | Out-Null
        } else {
            Write-SyncLog "gate $($gate.Name): no test failed twice (flaky: first $($unknown -join '; '); re-run $($rerunFailures -join '; '))"
        }
    }
    return , $red.ToArray()
}

# ---------------------------------------------------------------- agents

function Get-SchemaArg {
    return ((Get-Content -LiteralPath $SchemaFile -Raw) -replace '\s*\r?\n\s*', ' ').Trim()
}

function ConvertFrom-AgentJson([string]$Text) {
    $trimmed = $Text.Trim()
    if (-not $trimmed) { return $null }
    try { $outer = $trimmed | ConvertFrom-Json } catch { return $null }
    if ($outer.PSObject.Properties.Name -contains 'structured_output' -and $outer.structured_output) { return $outer.structured_output }
    if ($outer.PSObject.Properties.Name -contains 'status') { return $outer }
    if ($outer.PSObject.Properties.Name -contains 'result' -and $outer.result -is [string]) {
        $inner = ($outer.result -replace '^\s*```(json)?', '' -replace '```\s*$', '').Trim()
        try { return ($inner | ConvertFrom-Json) } catch { return $null }
    }
    return $null
}

function Invoke-TriageAgent([string]$InputText) {
    $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    $runbook = Get-Content -LiteralPath (Join-Path $SyncDir 'runbook-triage.md') -Raw
    # --safe-mode: no CLAUDE.md, hooks, plugins, skills or MCP; OAuth (the Max
    # plan) still works. Not --bare: that forces API-key billing. dontAsk +
    # --permission-prompts none: anything outside the allow-list is denied.
    $claudeArgs = @('-p', '--model', 'opus', '--effort', 'medium', '--safe-mode',
        '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--tools', 'Read,Grep,Glob,Bash',
        '--allowedTools', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(git merge-base *)',
        # Harmless readers to pipe git through. Claude Code refuses a `cd` plus a
        # pipe in one call whatever this list says (the 2026-09-26 triage lost
        # every diff to one), so the runbook also says: no cd, one command per call.
        'Bash(cd *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(wc *)',
        # `git diff/show/log --output=<file>` writes a file and matches the rules above.
        '--disallowedTools', 'Bash(git * --output*)',
        '--append-system-prompt', $runbook,
        '--output-format', 'json', '--json-schema', (Get-SchemaArg),
        '--no-session-persistence', '--name', 'upstream-sync-triage')
    $res = Invoke-Proc -FilePath $claude -ArgList $claudeArgs -StdinText $InputText -TimeoutSeconds $AgentTimeoutSeconds `
        -LogPath (Join-Path $RunDir 'triage-agent.log')
    $verdict = ConvertFrom-AgentJson -Text $res.Out
    if ($res.Code -ne 0 -or -not $verdict) {
        Stop-Sync 'stopped-red' "The triage agent failed (exit $($res.Code)); nothing merged. Log: $RunDir\triage-agent.log"
    }
    Set-Content -LiteralPath (Join-Path $RunDir 'triage.json') -Value ($verdict | ConvertTo-Json -Depth 10) -Encoding UTF8
    return $verdict
}

function Invoke-ResolveAgent([string]$Task, [string]$Name, [object[]]$Gates) {
    $gateText = @($Gates | ForEach-Object { "- ($($_.Dir)) $([System.IO.Path]::GetFileName($_.File)) $($_.Args -join ' ')" }) -join "`n"
    $triageText = ''
    if ($script:Triage) { $triageText = $script:Triage | ConvertTo-Json -Depth 10 }
    $prompt = (Get-Content -LiteralPath (Join-Path $SyncDir 'runbook-resolve.md') -Raw) +
    "`n`n## Task`n$Task`n`n## Triage verdict`n$triageText`n`n## Gate commands (run from the directory in parentheses)`n$gateText`n`n## Known pre-existing failures (ignore)`n" +
    ((Get-KnownFailures) -join "`n") + "`n"
    Set-Content -LiteralPath (Join-Path $RunDir "$Name-prompt.md") -Value $prompt -Encoding UTF8
    $headBefore = Get-GitText -GitArgs @('rev-parse', 'HEAD')
    $mainBefore = (Invoke-Git -GitArgs @('status', '--porcelain') -Repo $MainRepo).Out
    $verdictFile = Join-Path $RunDir "$Name-verdict.json"
    $verdict = $null
    $codexJs = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js'
    if (Test-Path -LiteralPath $codexJs) {
        Write-SyncLog "$Name`: codex exec (gpt-5.6-sol high) ..."
        $res = Invoke-Proc -FilePath $nodeExe -ArgList @($codexJs, 'exec', '--approve-for-me', '-m', 'gpt-5.6-sol',
            '-c', 'model_reasoning_effort="high"', '-C', $SyncRepo, '--output-schema', $SchemaFile, '-o', $verdictFile) `
            -StdinText $prompt -TimeoutSeconds $AgentTimeoutSeconds -LogPath (Join-Path $RunDir "$Name-codex.log")
        if ($res.Code -eq 0 -and (Test-Path -LiteralPath $verdictFile)) {
            $verdict = ConvertFrom-AgentJson -Text (Get-Content -LiteralPath $verdictFile -Raw)
        }
    }
    if (-not $verdict) {
        Write-SyncLog "$Name`: codex gave no verdict; falling back to claude -p (Opus 5 medium) ..."
        $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
        $claudeArgs = @('-p', '--model', 'opus', '--effort', 'medium', '--safe-mode',
            '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
            '--allowedTools', 'Bash(vp *)', 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git show *)', 'Bash(git log *)',
            'Bash(git add *)', 'Bash(git grep *)', 'Bash(node *)',
            'Bash(cd *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(wc *)',
            '--disallowedTools', 'Bash(git push *)', 'Bash(git commit *)', 'Bash(git reset *)', 'Bash(git checkout *)',
            'Bash(git switch *)', 'Bash(git stash *)', 'Bash(git rebase *)', 'Bash(powershell *)', 'Bash(pwsh *)',
            '--output-format', 'json', '--json-schema', (Get-SchemaArg), '--no-session-persistence', '--name', "upstream-sync-$Name")
        $res = Invoke-Proc -FilePath $claude -ArgList $claudeArgs -StdinText $prompt -TimeoutSeconds $AgentTimeoutSeconds `
            -LogPath (Join-Path $RunDir "$Name-claude.log")
        $verdict = ConvertFrom-AgentJson -Text $res.Out
    }
    if ((Get-GitText -GitArgs @('rev-parse', 'HEAD')) -ne $headBefore) {
        Stop-Sync 'stopped-judgment' "The $Name agent moved HEAD in the sync worktree. Nothing deployed; inspect $SyncRepo."
    }
    if ((Invoke-Git -GitArgs @('status', '--porcelain') -Repo $MainRepo).Out -ne $mainBefore) {
        Stop-Sync 'stopped-judgment' "The main checkout changed while the $Name agent ran. Nothing deployed; check $MainRepo."
    }
    if (-not $verdict) {
        Stop-Sync 'stopped-red' "The $Name agent produced no verdict (codex and claude). Branch kept in $SyncRepo."
    }
    Set-Content -LiteralPath $verdictFile -Value ($verdict | ConvertTo-Json -Depth 10) -Encoding UTF8
    return $verdict
}

# ---------------------------------------------------------------- steps

function Get-TriageInput([string]$Base, [string]$New, [string[]]$Conflicts) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# Upstream sync input") | Out-Null
    $lines.Add("merge-base $Base, upstream/main $New, fork main $(Get-GitText -GitArgs @('rev-parse', '--short=12', $OriginMain))") | Out-Null
    $lines.Add('') | Out-Null
    $lines.Add('## New upstream commits (oldest first) with the top-level areas they touch') | Out-Null
    $current = $null
    $areas = @{}
    $order = New-Object System.Collections.Generic.List[string]
    foreach ($line in (Get-GitLines -GitArgs @('log', '--reverse', '--format=@@%h %s', '--name-only', "$Base..$New"))) {
        if ($line.StartsWith('@@')) { $current = $line.Substring(2); $order.Add($current) | Out-Null; $areas[$current] = @{}; continue }
        if ($current) {
            $parts = $line -split '/'
            $area = if ($parts.Count -ge 3) { ($parts[0..2] -join '/') } else { $line }
            $areas[$current][$area] = $true
        }
    }
    foreach ($commit in $order) { $lines.Add("- $commit  [$((@($areas[$commit].Keys) | Sort-Object) -join ', ')]") | Out-Null }
    $lines.Add('') | Out-Null
    $lines.Add('## Files changed on both sides since the merge-base (ours | upstream)') | Out-Null
    $ours = @(Get-GitLines -GitArgs @('diff', '--name-only', $Base, $OriginMain))
    $theirs = @(Get-GitLines -GitArgs @('diff', '--name-only', $Base, $New))
    $both = @($ours | Where-Object { $theirs -contains $_ })
    foreach ($file in ($both | Select-Object -First 120)) {
        $o = Get-GitText -GitArgs @('diff', '--shortstat', $Base, $OriginMain, '--', $file)
        $t = Get-GitText -GitArgs @('diff', '--shortstat', $Base, $New, '--', $file)
        $lines.Add("- $file | ours: $o | upstream: $t") | Out-Null
    }
    $lines.Add('') | Out-Null
    $lines.Add('## Upstream migration changes') | Out-Null
    foreach ($m in (Get-GitLines -GitArgs @('diff', '--name-status', $Base, $New, '--', 'apps/server/src/persistence/Migrations/'))) { $lines.Add("- $m") | Out-Null }
    $lines.Add('') | Out-Null
    $lines.Add('## Dry-merge conflicts') | Out-Null
    foreach ($c in $Conflicts) { $lines.Add("- $c") | Out-Null }
    $lines.Add('') | Out-Null
    $lines.Add('## Decisions already pending with the owner (held-upstream.json)') | Out-Null
    $lines.Add((Get-Content -LiteralPath $HeldFile -Raw)) | Out-Null
    return ($lines -join "`n")
}

function Get-MaxMigrationId {
    $source = Get-Content -LiteralPath (Join-Path $SyncRepo 'apps\server\src\persistence\Migrations.ts') -Raw
    $ids = @([regex]::Matches($source, '(?m)^\s*\[(\d+), "[^"]+", \w+\],$') | ForEach-Object { [int]$_.Groups[1].Value })
    return ($ids | Measure-Object -Maximum).Maximum
}

function Get-DecisionText([object[]]$Decisions) {
    $parts = @()
    foreach ($d in $Decisions) {
        $parts += ("Needs your call ({0}): {1} Options: {2}. Recommended: {3}" -f $d.id, $d.whatChanged, (@($d.options) -join ' / '), $d.recommendation)
    }
    return ($parts -join "`n")
}

function Invoke-PsScript([string]$Name, [string[]]$ScriptArgs, [int]$TimeoutSeconds = 3600) {
    $log = Join-Path $RunDir ("{0}.log" -f [System.IO.Path]::GetFileNameWithoutExtension($Name))
    $res = Invoke-Proc -FilePath $powershellExe -ArgList (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $Name)) + $ScriptArgs) `
        -WorkingDirectory $SyncRepo -TimeoutSeconds $TimeoutSeconds -LogPath $log
    Write-SyncLog ("{0} exited {1}" -f $Name, $res.Code)
    return $res
}

function Invoke-Sync {
    # ---- 0. preflight (no side effects)
    if ((Resolve-Path -LiteralPath $SyncRepo).Path -eq (Resolve-Path -LiteralPath $MainRepo).Path) {
        Stop-Sync 'stopped-judgment' 'upstream-sync.ps1 must run from the sync worktree, not the main checkout.'
    }
    [void](Invoke-Git -GitArgs @('fetch', 'origin'))
    [void](Invoke-Git -GitArgs @('fetch', 'upstream'))
    $originMain = Get-GitText -GitArgs @('rev-parse', $OriginMain)
    $localMain = Get-GitText -GitArgs @('rev-parse', 'personal-bots/main')
    if ($localMain -ne $originMain -and
        (Invoke-Git -GitArgs @('merge-base', '--is-ancestor', $originMain, $localMain) -AllowFail).Code -eq 0) {
        Stop-Sync 'stopped-judgment' 'personal-bots/main has unpushed commits. Push or drop them before the sync can run.'
    }
    $mainDirty = @((Invoke-Git -GitArgs @('status', '--porcelain', '--untracked-files=no') -Repo $MainRepo).Out -split "`r?`n" | Where-Object { $_ })
    if ($mainDirty.Count -gt 0) {
        $old = Read-SyncState
        $skips = 1
        if ($old -and $old.lastResult -eq 'skipped-preflight') { $skips = [int]$old.consecutivePreflightSkips + 1 }
        if (-not $PreflightOnly) { Save-SyncState @{ lastResult = 'skipped-preflight'; consecutivePreflightSkips = $skips } }
        if ($skips -ge 3 -and -not $PreflightOnly) {
            Send-Notify "Bots upstream sync skipped $skips days in a row: the main checkout has uncommitted work ($($mainDirty.Count) file(s)). Commit or stash it and the next run will sync."
        }
        Write-SyncLog "main checkout has uncommitted work ($($mainDirty.Count) file(s)); retrying tomorrow"
        $script:StopResult = 'skipped-preflight'
        return
    }
    $live = Get-LiveRelease
    $originShort = $originMain.Substring(0, 12)
    if (-not $live -or $live -ne $originShort) {
        Stop-Sync 'stopped-judgment' "main has undeployed commits (live release '$live', origin main $originShort). Deploy or revert first; the sync only ever deploys the upstream delta."
    }
    $syncDirty = @((Invoke-Git -GitArgs @('status', '--porcelain')).Out -split "`r?`n" | Where-Object { $_ })
    if ($syncDirty.Count -gt 0) {
        Stop-Sync 'stopped-judgment' "The sync worktree $SyncRepo is dirty; an earlier run needs attention."
    }
    $base = Get-GitText -GitArgs @('merge-base', $OriginMain, $UpstreamMain)
    $state = Read-SyncState
    if ($state -and $state.lastSyncedUpstream -and $state.lastSyncedUpstream -ne $base) {
        Stop-Sync 'stopped-judgment' "State drift: state.json says synced through $($state.lastSyncedUpstream) but the merge-base is $base."
    }
    $drive = Get-PSDrive -Name ($SyncRepo.Substring(0, 1))
    if ($drive.Free -lt 5GB) { Stop-Sync 'stopped-judgment' "Less than 5 GB free on $($drive.Name):." }

    # ---- 1. anything new, anything for us
    $new = Get-GitText -GitArgs @('rev-parse', $UpstreamMain)
    $newShort = $new.Substring(0, 9)
    if ($new -eq $base) {
        Write-SyncLog 'upstream has nothing new'
        if (-not $PreflightOnly) { Save-SyncState @{ lastResult = 'skipped-no-new'; lastSyncedUpstream = $base; consecutivePreflightSkips = 0 } }
        $script:StopResult = 'skipped-no-new'
        return
    }
    $commitCount = [int](Get-GitText -GitArgs @('rev-list', '--count', "$base..$new"))
    $relevantCount = [int](Get-GitText -GitArgs (@('rev-list', '--count', "$base..$new", '--') + $RelevantPaths))
    $mergeTree = Invoke-Git -GitArgs @('merge-tree', '--write-tree', '--name-only', '--no-messages', $OriginMain, $new) -AllowFail
    $conflicts = @(($mergeTree.Out -split "`r?`n" | Where-Object { $_ }) | Select-Object -Skip 1)
    Write-SyncLog "upstream $newShort`: $commitCount new commit(s), $relevantCount touching our build, $($conflicts.Count) conflicted path(s)"
    if ($PreflightOnly) {
        Write-SyncLog "preflight OK. Conflicts: $($conflicts -join ', ')"
        $script:StopResult = 'preflight-ok'
        return
    }
    if ($relevantCount -eq 0 -and -not $Force) {
        Save-SyncState @{ lastResult = 'skipped-no-relevant'; consecutivePreflightSkips = 0 }
        Send-Notify "Bots upstream sync: $commitCount new upstream commit(s), none touching the Bots build. Nothing merged."
        $script:StopResult = 'skipped-no-relevant'
        return
    }
    if ($commitCount -gt $MaxCommits) { Stop-Sync 'stopped-judgment' "$commitCount upstream commits (limit $MaxCommits). Merge this one by hand." }
    if ($conflicts.Count -gt $MaxConflicts) { Stop-Sync 'stopped-judgment' "$($conflicts.Count) conflicted paths (limit $MaxConflicts). Merge this one by hand." }

    # ---- 2. triage (read-only agent)
    $triageInput = Get-TriageInput -Base $base -New $new -Conflicts $conflicts
    Set-Content -LiteralPath (Join-Path $RunDir 'triage-input.md') -Value $triageInput -Encoding UTF8
    Write-SyncLog 'triage (claude -p, Opus 5 medium, read-only) ...'
    $script:Triage = Invoke-TriageAgent -InputText $triageInput
    $decisions = @($script:Triage.decisions)
    if ($script:Triage.status -eq 'needs_judgment') {
        Stop-Sync 'stopped-judgment' ("Bots upstream sync stopped for a human (upstream $newShort): " + (@($script:Triage.reasons) -join '; '))
    }
    if ($script:Triage.status -eq 'nothing_relevant' -and -not $Force) {
        Save-SyncState @{ lastResult = 'skipped-no-relevant'; consecutivePreflightSkips = 0 }
        Send-Notify ("Bots upstream sync: nothing relevant in $commitCount upstream commit(s). " + $script:Triage.summary)
        $script:StopResult = 'skipped-no-relevant'
        return
    }

    # ---- 3. merge on the sync branch
    $branch = 'sync/upstream-' + (Get-Date -Format 'yyyyMMdd')
    if ((Invoke-Git -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$branch") -AllowFail).Code -eq 0) {
        $branch = $branch + '-' + (Get-Date -Format 'HHmm')
    }
    [void](Invoke-Git -GitArgs @('switch', '-c', $branch, $OriginMain))
    $mainEnv = Join-Path $MainRepo '.env'
    if (Test-Path -LiteralPath $mainEnv) { Copy-Item -LiteralPath $mainEnv -Destination (Join-Path $SyncRepo '.env') -Force }
    $merge = Invoke-Git -GitArgs @('merge', '--no-ff', '--no-commit', $new) -AllowFail
    Write-SyncLog "git merge exited $($merge.Code)"
    $unmerged = @(Get-GitLines -GitArgs @('diff', '--name-only', '--diff-filter=U'))
    $upstreamMigrations = @(Get-GitLines -GitArgs @('diff', '--name-only', '--diff-filter=A', $base, $new, '--', 'apps/server/src/persistence/Migrations/'))
    if ($unmerged -contains 'apps/server/src/persistence/Migrations.ts' -or $upstreamMigrations.Count -gt 0) {
        $mig = Invoke-Proc -FilePath $nodeExe -ArgList @('--disable-warning=ExperimentalWarning', 'scripts/personal/sync/resolve-migrations.ts', '--base', $base, '--upstream', $new) `
            -LogPath (Join-Path $RunDir 'resolve-migrations.log')
        Write-SyncLog "resolve-migrations: $($mig.Out.Trim())"
        if ($mig.Code -eq 2) { Stop-Sync 'stopped-judgment' "Upstream migrations need a human: $($mig.Out.Trim())" }
        if ($mig.Code -ne 0) { Stop-Sync 'stopped-red' "resolve-migrations.ts failed: $($mig.Out.Trim()) $($mig.Err.Trim())" }
    }
    $routeTreeConflict = $unmerged -contains 'apps/web/src/routeTree.gen.ts'
    if ($routeTreeConflict) { [void](Invoke-Git -GitArgs @('checkout', '--ours', '--', 'apps/web/src/routeTree.gen.ts')) }
    $gates = Get-GateList -Base $base -New $new
    $remaining = @(Get-GitLines -GitArgs @('diff', '--name-only', '--diff-filter=U') |
            Where-Object { $_ -ne 'apps/web/src/routeTree.gen.ts' -and $_ -ne 'apps/server/src/persistence/Migrations.ts' })
    if ($remaining.Count -gt 0) {
        $verdict = Invoke-ResolveAgent -Name 'resolve' -Gates $gates -Task ("Resolve these merge conflicts (merging upstream $new into $OriginMain):`n" + (($remaining | ForEach-Object { "- $_" }) -join "`n") + "`nThe triage's dry-merge list and the files changed on both sides are in the triage verdict below.")
        if ($verdict.status -ne 'resolved') { Stop-Sync 'stopped-judgment' ("Merge conflicts need a human: " + (@($verdict.reasons) -join '; ')) }
    }
    if ($routeTreeConflict) { [void](Invoke-Git -GitArgs @('add', 'apps/web/src/routeTree.gen.ts')) }
    if (@(Get-GitLines -GitArgs @('ls-files', '-u')).Count -gt 0) { Stop-Sync 'stopped-judgment' 'Unmerged paths remain after the resolve step.' }
    $markers = Invoke-Git -GitArgs @('grep', '-nE', '^(<<<<<<<|>>>>>>>)( |$)', '--', '.', ':!*.md') -AllowFail
    if ($markers.Code -eq 0 -and $markers.Out.Trim()) { Stop-Sync 'stopped-judgment' "Conflict markers remain: $($markers.Out.Trim().Split("`n")[0])" }

    # ---- 4. install, regenerate, commit the merge (local branch only)
    Invoke-PbNative -FilePath 'vp' -Arguments @('i') -WorkingDirectory $SyncRepo
    $gen = Invoke-Proc -FilePath $nodeExe -ArgList @('scripts/personal/sync/gen-route-tree.mjs') -LogPath (Join-Path $RunDir 'gen-route-tree.log')
    if ($gen.Code -ne 0) { Stop-Sync 'stopped-red' "Route tree regeneration failed: $($gen.Err.Trim())" }
    [void](Invoke-Git -GitArgs @('add', 'pnpm-lock.yaml', 'apps/web/src/routeTree.gen.ts'))
    [void](Invoke-Git -GitArgs @('commit', '-m', "merge: upstream/main $newShort into personal-bots/main (weekly sync)", '-m', "Automated by scripts/personal/upstream-sync.ps1 (run $Stamp)."))

    # ---- 5. hold back what needs the owner's decision
    $held = @()
    foreach ($decision in $decisions) {
        $holdBy = [string]$decision.holdBy
        $revertCommit = $null
        if ($holdBy -eq 'revert') {
            $shas = @($decision.shas)
            [array]::Reverse($shas)
            $revert = Invoke-Git -GitArgs (@('revert', '--no-commit') + $shas) -AllowFail
            if ($revert.Code -eq 0) {
                [void](Invoke-Git -GitArgs @('commit', '-m', "revert(sync): hold $($decision.id) for the owner's decision", '-m', ("Upstream: " + (@($decision.shas) -join ', ') + "`n" + $decision.whatChanged)))
                $revertCommit = Get-GitText -GitArgs @('rev-parse', '--short=12', 'HEAD')
            } else {
                [void](Invoke-Git -GitArgs @('revert', '--abort') -AllowFail)
                Write-SyncLog "revert of $($decision.id) does not apply cleanly; keeping our side instead"
                $holdBy = 'keep_ours'
            }
        }
        if ($holdBy -eq 'keep_ours') {
            $verdict = Invoke-ResolveAgent -Name ("hold-" + $decision.id) -Gates $gates -Task ("Hold decision '$($decision.id)' for the owner: keep our current behaviour for: $($decision.whatChanged) (upstream commits $(@($decision.shas) -join ', ')). Smallest pin; add a test that fails if upstream's behaviour returns.")
            if ($verdict.status -ne 'resolved') { Stop-Sync 'stopped-judgment' "Could not hold '$($decision.id)' back: $(@($verdict.reasons) -join '; ')" }
            [void](Invoke-Git -GitArgs @('commit', '-m', "fix(sync): keep our behaviour for $($decision.id) (held for the owner)"))
            $revertCommit = Get-GitText -GitArgs @('rev-parse', '--short=12', 'HEAD')
        }
        $held += [ordered]@{
            id = $decision.id; shas = @($decision.shas); area = $decision.area; whatChanged = $decision.whatChanged
            options = @($decision.options); recommendation = $decision.recommendation; holdBy = $holdBy
            revertCommit = $revertCommit; heldAt = (Get-Date -Format 'yyyy-MM-dd'); upstream = $newShort
        }
    }
    if ($held.Count -gt 0) {
        $heldDoc = Get-Content -LiteralPath $HeldFile -Raw | ConvertFrom-Json
        $all = @($heldDoc.held) + $held
        # Every other key (accepted, $acceptedComment) is kept as it was.
        $out = [ordered]@{}
        foreach ($prop in $heldDoc.PSObject.Properties) { $out[$prop.Name] = $prop.Value }
        $out['held'] = $all
        Set-Content -LiteralPath $HeldFile -Value ($out | ConvertTo-Json -Depth 10) -Encoding UTF8
        [void](Invoke-Git -GitArgs @('add', 'scripts/personal/sync/held-upstream.json'))
        [void](Invoke-Git -GitArgs @('commit', '-m', ("chore(sync): record held upstream decisions (" + (@($held | ForEach-Object { $_.id }) -join ', ') + ")")))
    }

    # ---- 6. version bump (minor per sync)
    $versionFile = Join-Path $PSScriptRoot 'app-version.txt'
    $oldVersion = (Get-Content -LiteralPath $versionFile -First 1).Trim()
    if ($oldVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') { Stop-Sync 'stopped-red' "app-version.txt holds '$oldVersion', not x.y.z." }
    $newVersion = '{0}.{1}.0' -f $Matches[1], ([int]$Matches[2] + 1)
    Set-Content -LiteralPath $versionFile -Value $newVersion -Encoding ASCII
    [void](Invoke-Git -GitArgs @('add', 'scripts/personal/app-version.txt'))
    [void](Invoke-Git -GitArgs @('commit', '-m', "chore(bots): v$newVersion (weekly upstream sync $newShort)"))

    # ---- 7. gates (script re-runs everything; one repair round)
    $red = Invoke-Gates -Gates $gates -Label 'first'
    if ($red.Count -gt 0) {
        Write-SyncLog "red gates: $($red -join ' | ')"
        $verdict = Invoke-ResolveAgent -Name 'repair' -Gates $gates -Task ("These gates are red after the merge. Fix the cause (never skip or delete a test):`n" + (($red | ForEach-Object { "- $_" }) -join "`n"))
        if (@(Get-GitLines -GitArgs @('status', '--porcelain')).Count -gt 0) {
            [void](Invoke-Git -GitArgs @('add', '-A'))
            [void](Invoke-Git -GitArgs @('commit', '-m', "fix(sync): repair gates after merging upstream $newShort"))
        }
        $red = Invoke-Gates -Gates $gates -Label 'second'
        if ($red.Count -gt 0) {
            Stop-Sync 'stopped-red' ("Bots upstream sync stopped: gates still red after one repair round (branch $branch kept, nothing deployed): " + ($red -join ' | '))
        }
    }

    # ---- 8. build + rehearsal on a copy of a fresh backup (never the live DB)
    $build = Invoke-PsScript -Name 'build.ps1' -ScriptArgs @('-NoActivate', '-CopyExternals') -TimeoutSeconds 2400
    if ($build.Code -ne 0) { Stop-Sync 'stopped-red' "build.ps1 failed (exit $($build.Code)); nothing deployed. Log: $RunDir\build.log" }
    $release = Get-GitText -GitArgs @('rev-parse', '--short=12', 'HEAD')
    $backup = Invoke-PsScript -Name 'backup.ps1' -ScriptArgs @()
    if ($backup.Code -ne 0) { Stop-Sync 'stopped-red' "backup.ps1 failed (exit $($backup.Code)); nothing deployed." }
    $maxId = Get-MaxMigrationId
    $rehearsal = Invoke-PsScript -Name 'restore-test.ps1' -ScriptArgs @('-Release', $release, '-ExpectMigration', [string]$maxId, '-Seconds', '60')
    if ($rehearsal.Code -ne 0) { Stop-Sync 'stopped-red' "Migration rehearsal failed on a backup copy (expected migration $maxId); nothing deployed. $($rehearsal.Out.Trim())" }

    $decisionText = Get-DecisionText -Decisions $decisions
    $summary = [string]$script:Triage.pushText
    if (-not $summary) { $summary = [string]$script:Triage.summary }
    if ($Mode -eq 'DryRun') {
        Save-SyncState @{ lastResult = 'dry-run-green'; lastRelease = $release; consecutivePreflightSkips = 0 }
        Send-Notify ("Bots $newVersion is ready to ship (upstream $newShort, $commitCount commits; dry run: nothing deployed). $summary`n$decisionText`nShip: restart.ps1 -Release $release, then push $branch.")
        $script:StopResult = 'dry-run-green'
        return
    }

    # ---- 9. deploy, smoke, push or roll back
    [void](Invoke-Git -GitArgs @('fetch', 'origin'))
    if ((Get-GitText -GitArgs @('rev-parse', $OriginMain)) -ne $originMain) {
        Stop-Sync 'stopped-judgment' "personal-bots/main moved during the sync; nothing deployed. Re-run (branch $branch kept)."
    }
    $previousRelease = Get-LiveRelease
    $logFile = Join-Path $paths.LogsDir ('server-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
    $logOffset = 0
    if (Test-Path -LiteralPath $logFile) { $logOffset = (Get-Item -LiteralPath $logFile).Length }
    $restart = Invoke-PsScript -Name 'restart.ps1' -ScriptArgs @('-Release', $release) -TimeoutSeconds 300
    $smoke = Invoke-PsScript -Name 'smoke.ps1' -ScriptArgs @('-ExpectRelease', $release, '-LogFile', $logFile, '-LogFromByte', [string]$logOffset) -TimeoutSeconds 900
    if ($restart.Code -eq 0 -and $smoke.Code -eq 0) {
        $push = Invoke-Git -GitArgs @('push', 'origin', "HEAD:refs/heads/personal-bots/main") -AllowFail
        if ($push.Code -ne 0) {
            Save-SyncState @{ lastResult = 'deployed-push-rejected'; lastRelease = $release; previousRelease = $previousRelease }
            Send-Notify "Bots $newVersion is live (release $release) but the push to personal-bots/main was rejected (main moved). Never forced: merge $branch by hand. $($push.Err.Trim())" -Alert
            $script:StopResult = 'deployed-push-rejected'
            return
        }
        Save-SyncState @{ lastResult = 'deployed'; lastRelease = $release; previousRelease = $previousRelease; lastSyncedUpstream = $new; consecutivePreflightSkips = 0 }
        Send-Notify ("Bots $newVersion is live (upstream $newShort, $commitCount commits). $summary`nGates green; rollback ready ($previousRelease). Open Bots twice to load it.`n$decisionText")
        $script:StopResult = 'deployed'
        return
    }

    Write-SyncLog "smoke failed (restart $($restart.Code), smoke $($smoke.Code)); rolling back to $previousRelease"
    $back = Invoke-PsScript -Name 'restart.ps1' -ScriptArgs @('-Release', $previousRelease) -TimeoutSeconds 300
    $backSmoke = Invoke-PsScript -Name 'smoke.ps1' -ScriptArgs @('-ExpectRelease', $previousRelease, '-StableSeconds', '60') -TimeoutSeconds 600
    $restoreHelp = "Manual DB restore only if you decide it is needed: stop.ps1; copy the newest backups\<stamp>\state.sqlite over dev\userdata\state.sqlite (delete state.sqlite-wal/-shm first, keep secrets\); restart.ps1 -Release $previousRelease."
    if ($back.Code -eq 0 -and $backSmoke.Code -eq 0) {
        Save-SyncState @{ lastResult = 'rolled-back'; lastRelease = $previousRelease; previousRelease = $release }
        Send-Notify ("Bots upstream sync rolled back: $newVersion (release $release) failed the live smoke, so $previousRelease is live again. Branch $branch kept, not pushed. Smoke: " + (($smoke.Out -split "`r?`n" | Where-Object { $_ -match 'FAIL' }) -join ' | ') + "`n$restoreHelp")
        $script:StopResult = 'rolled-back'
        return
    }
    Save-SyncState @{ lastResult = 'down'; lastRelease = $null; previousRelease = $previousRelease }
    Send-Notify ("Bots is DOWN: $newVersion failed its smoke and the rollback to $previousRelease also failed. Supervisor left alone. Logs: $RunDir. $restoreHelp") -Alert
    $script:StopResult = 'down'
}

# ---------------------------------------------------------------- probe
#
# Nightly early warning. Pure script: no agent, no build, no deploy, no push,
# and not one write to anything the Saturday run reads. Everything it needs to
# remember lives in probe-state.json.
#
# Cleanup contract for the scratch merge (the only artefact Probe creates):
#  - the dry merge itself is `git merge-tree --write-tree`, which touches no
#    ref, no index and no worktree; it only writes loose objects.
#  - to run gates on a clean result the tree is wrapped by `git commit-tree`.
#    That commit is never pointed at by a branch, tag, note, stash or HEAD of
#    anything that survives the run, so it stays unreachable and git gc reaps
#    it. No ref is created, therefore no ref has to be deleted.
#  - the scratch worktree is detached at that unreachable commit, lives outside
#    every checkout (%USERPROFILE%\.personal-bots\upstream-sync\probe-scratch)
#    and is removed in a finally block.
#  - a kill -9 is covered too: Remove-ProbeScratch also runs at the START of
#    every probe, so a scratch left by an interrupted run is gone before the
#    next one begins. Cleanup is therefore idempotent, not best-effort.

$AutoResolvedConflicts = @('apps/web/src/routeTree.gen.ts', 'apps/server/src/persistence/Migrations.ts')

function Read-ProbeState {
    if (-not (Test-Path -LiteralPath $ProbeStateFile -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $ProbeStateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Save-ProbeState([hashtable]$Changes) {
    $state = [ordered]@{
        lastRunAt        = $null
        lastResult       = $null
        lastUpstream     = $null
        lastPending      = 0
        lastConflicts    = @()
        lastNotifiedKey  = $null
        lastNotifiedAt   = $null
        lastNotifiedText = $null
    }
    $old = Read-ProbeState
    if ($old) { foreach ($prop in $old.PSObject.Properties) { $state[$prop.Name] = $prop.Value } }
    foreach ($key in $Changes.Keys) { $state[$key] = $Changes[$key] }
    $state.lastRunAt = (Get-Date).ToUniversalTime().ToString('o')
    Set-Content -LiteralPath $ProbeStateFile -Value ($state | ConvertTo-Json -Depth 5) -Encoding UTF8
}

# One push notification per distinct finding. The same finding repeats silently
# until it changes, with a single reminder once a week so a conflict that sits
# there for a month is not forgotten. Being ignorable is the failure mode here.
function Send-ProbeNotify([string]$Key, [string]$Message) {
    $state = Read-ProbeState
    if ($state -and $state.lastNotifiedKey -eq $Key -and $state.lastNotifiedAt) {
        $age = (Get-Date).ToUniversalTime() - ([datetime]$state.lastNotifiedAt).ToUniversalTime()
        if ($age.TotalDays -lt $ProbeRemindDays) {
            Write-SyncLog ("notify suppressed (same finding as {0:0.0} day(s) ago): {1}" -f $age.TotalDays, $Message)
            return $false
        }
    }
    Send-Notify $Message
    Save-ProbeState @{ lastNotifiedKey = $Key; lastNotifiedAt = (Get-Date).ToUniversalTime().ToString('o'); lastNotifiedText = $Message }
    return $true
}

function Remove-ProbeScratch {
    # Deliberately NOT `git worktree remove`: measured on this laptop it fails
    # with "Filename too long" on pnpm's deep node_modules paths, and it
    # deregisters the worktree before it fails, so the directory is orphaned
    # and git no longer knows about it. rmdir /s /q handles those paths, and
    # unlinks reparse points instead of following them, so pnpm's symlink farm
    # is removed and never dereferenced. prune then clears the registration.
    if (Test-Path -LiteralPath $ProbeScratch) {
        Write-SyncLog "removing scratch worktree $ProbeScratch"
        [void](Invoke-Proc -FilePath $env:ComSpec -ArgList @('/c', 'rmdir', '/s', '/q', $ProbeScratch) `
                -WorkingDirectory $SyncHome -TimeoutSeconds 1800)
    }
    [void](Invoke-Git -GitArgs @('worktree', 'prune') -AllowFail)
    if (Test-Path -LiteralPath $ProbeScratch) { throw "Could not remove the probe scratch worktree $ProbeScratch." }
}

function Get-ProbeGateList([string]$Root) {
    $vp = Join-Path $Root 'node_modules\.bin\vp.cmd'
    # The fast pair only. Never an unfiltered `vp test run` in apps\server: it
    # wedges for 15+ minutes, which is exactly what a 07:00 probe must not do.
    return @(
        @{ Name = 'test-server'; Dir = 'apps\server'; File = $vp; Args = @('test', 'run', 'src/personal'); Kind = 'vitest' },
        @{ Name = 'test-web'; Dir = 'apps\web'; File = $vp; Args = @('test', 'run', '--project', 'unit', 'src/features/personal'); Kind = 'vitest' }
    )
}

function Invoke-ProbeGates([string]$Tree, [string]$Upstream, [string]$LogDir) {
    $commit = Get-GitText -GitArgs @('commit-tree', $Tree, '-p', $OriginMain, '-p', $Upstream,
        '-m', 'probe: dry merge of upstream (unreferenced, never pushed)')
    Write-SyncLog "scratch worktree at $ProbeScratch (unreferenced commit $($commit.Substring(0,9)))"
    [void](Invoke-Git -GitArgs @('worktree', 'add', '--detach', '--quiet', $ProbeScratch, $commit))
    # The scratch has no node_modules yet, so bootstrap with the sync worktree's
    # vp. Plain `vp i` (not --frozen-lockfile) to mirror what Auto does: a
    # merged lockfile is allowed to need regenerating, and only in the scratch.
    $install = Invoke-Proc -FilePath (Join-Path $SyncRepo 'node_modules\.bin\vp.cmd') -ArgList @('i') `
        -WorkingDirectory $ProbeScratch -TimeoutSeconds 1800 -LogPath (Join-Path $LogDir 'probe-install.log')
    Write-SyncLog "scratch install exited $($install.Code)"
    if ($install.Code -ne 0) { return , @("install: vp i failed on the merged tree (exit $($install.Code); log $LogDir\probe-install.log)") }
    # Assign, never @(): Invoke-Gates returns a comma-wrapped array so that an
    # empty result survives, and wrapping that in @() turns "no red gates" into
    # one element that prints as "System.String[]" - a probe that cannot tell
    # green from red. Auto assigns directly for the same reason.
    $gateRed = Invoke-Gates -Gates (Get-ProbeGateList -Root $ProbeScratch) -Label 'probe' -Root $ProbeScratch -LogDir $LogDir
    return , $gateRed
}

# Probe is read-only towards whatever checkout it runs from: it only reads
# refs, writes loose objects and works inside its own scratch. So, unlike Auto,
# it may run from the main checkout - which matters, because the sync worktree
# is often parked mid-merge after a stopped sync, and that is exactly when the
# early warning is worth the most. These snapshots turn "read-only" into
# something the run proves rather than claims.
function Get-ProbeRepoFingerprint([string]$Repo) {
    if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { return $null }
    $head = (Invoke-Git -GitArgs @('rev-parse', 'HEAD') -Repo $Repo -AllowFail).Out.Trim()
    $branch = (Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD') -Repo $Repo -AllowFail).Out.Trim()
    $dirty = @((Invoke-Git -GitArgs @('status', '--porcelain') -Repo $Repo -AllowFail).Out -split "`r?`n" | Where-Object { $_ }).Count
    $branches = (Invoke-Git -GitArgs @('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash') -Repo $Repo -AllowFail).Out.Trim()
    return [pscustomobject]@{ Head = $head; Branch = $branch; Dirty = $dirty; Refs = $branches }
}

function Assert-ProbeLeftNoTrace($Before) {
    $now = @(Get-ProbeWorktrees)
    $strays = @($now | Where-Object { -not $Before.Contains(($_ -replace '/', '\')) })
    if ($strays.Count -gt 0) { Write-SyncLog "probe WARNING: stray worktree(s) left behind: $($strays -join ', ')" }
    else { Write-SyncLog "probe: no stray worktrees ($($now.Count) registered, same as before)" }
    foreach ($repo in @($Before.Keys)) {
        $after = Get-ProbeRepoFingerprint -Repo $repo
        $was = $Before[$repo]
        if (-not $was -or -not $after) { continue }
        $changed = @()
        if ($after.Head -ne $was.Head) { $changed += "HEAD $($was.Head.Substring(0,9)) -> $($after.Head.Substring(0,9))" }
        if ($after.Branch -ne $was.Branch) { $changed += "branch $($was.Branch) -> $($after.Branch)" }
        if ($after.Refs -ne $was.Refs) { $changed += 'local branches/tags/stash changed' }
        if ($changed.Count -gt 0) { Write-SyncLog "probe WARNING: $repo changed while the probe ran ($($changed -join '; '))" }
        else { Write-SyncLog "probe: $repo untouched (HEAD $($after.Head.Substring(0,9)), branch $($after.Branch), refs identical)" }
        # The modified-path count is reported, never warned about: the owner
        # editing his own checkout while the probe runs is normal, and the
        # probe writes to no checkout, only to its own scratch.
        if ($after.Dirty -ne $was.Dirty) {
            Write-SyncLog "probe: $repo has $($was.Dirty) -> $($after.Dirty) modified path(s) (someone else was editing; not the probe)"
        }
    }
}

function Get-ProbeWorktrees {
    return @(Get-GitLines -GitArgs @('worktree', 'list', '--porcelain') | Where-Object { $_ -like 'worktree *' } |
            ForEach-Object { $_.Substring('worktree '.Length) })
}

function Invoke-Probe {
    $before = [ordered]@{}
    foreach ($repo in (@($SyncRepo, $MainRepo) + (Get-ProbeWorktrees))) {
        $full = $repo -replace '/', '\'
        if (-not $before.Contains($full)) { $before[$full] = Get-ProbeRepoFingerprint -Repo $full }
    }
    $script:ProbeBefore = $before
    Remove-ProbeScratch
    [void](Invoke-Git -GitArgs @('fetch', 'origin'))
    [void](Invoke-Git -GitArgs @('fetch', 'upstream'))
    $target = $UpstreamMain
    if ($ProbeUpstreamRef) {
        $target = $ProbeUpstreamRef
        Write-SyncLog "probe: probing $target instead of $UpstreamMain (-ProbeUpstreamRef)"
    }
    $base = Get-GitText -GitArgs @('merge-base', $OriginMain, $target)
    $new = Get-GitText -GitArgs @('rev-parse', $target)
    $newShort = $new.Substring(0, 9)
    if ($new -eq $base) {
        Write-SyncLog 'probe: upstream has nothing new'
        Save-ProbeState @{ lastResult = 'no-new'; lastUpstream = $new; lastPending = 0; lastConflicts = @() }
        return 'no-new'
    }
    $pending = [int](Get-GitText -GitArgs @('rev-list', '--count', "$base..$new"))
    $relevant = [int](Get-GitText -GitArgs (@('rev-list', '--count', "$base..$new", '--') + $RelevantPaths))

    # merge-tree is the whole dry run: no ref, no index, no worktree, no branch.
    # Exit 0 = clean and the only line is the merged tree; exit 1 = the tree
    # plus the conflicted paths.
    $mergeTree = Invoke-Git -GitArgs @('merge-tree', '--write-tree', '--name-only', '--no-messages', $OriginMain, $new) -AllowFail
    $lines = @($mergeTree.Out -split "`r?`n" | Where-Object { $_ })
    if ($lines.Count -eq 0) { throw "git merge-tree produced no output (exit $($mergeTree.Code)): $($mergeTree.Err.Trim())" }
    $tree = $lines[0]
    $conflicts = @($lines | Select-Object -Skip 1)
    $handled = @($conflicts | Where-Object { $AutoResolvedConflicts -contains $_ })
    $real = @($conflicts | Where-Object { $AutoResolvedConflicts -notcontains $_ })
    Write-SyncLog ("probe: upstream {0}, {1} commit(s) pending, {2} touching our build, {3} conflicted path(s) ({4} auto-resolved)" -f `
            $newShort, $pending, $relevant, $conflicts.Count, $handled.Count)
    if ($handled.Count -gt 0) { Write-SyncLog "probe: auto-resolved conflicts (not a finding): $($handled -join ', ')" }

    $result = 'clean'
    $notified = $false
    if ($real.Count -gt 0) {
        $result = 'conflict'
        $sorted = @($real | Sort-Object)
        $limit = ''
        if ($conflicts.Count -gt $MaxConflicts) { $limit = " That is over the sync's limit of $MaxConflicts conflicted paths, so Saturday's run will refuse it outright." }
        $notified = Send-ProbeNotify -Key ("conflict:" + ($sorted -join '|')) -Message (
            "Bots upstream probe: the weekly sync will hit $($sorted.Count) merge conflict(s) (upstream $newShort, $pending commit(s) pending). Files: " +
            ($sorted -join ', ') + ".$limit Nothing was merged, built or deployed.")
    } elseif ($relevant -eq 0) {
        $result = 'clean-nothing-relevant'
        Write-SyncLog 'probe: merge is clean and no pending commit touches our build; gates skipped'
    } else {
        $logDir = Join-Path $SyncHome 'probe-gate-logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        Write-SyncLog "probe: merge is clean; running the two fast gates in the scratch worktree"
        $red = Invoke-ProbeGates -Tree $tree -Upstream $new -LogDir $logDir
        if ($red.Count -gt 0) {
            $result = 'gates-red'
            $sorted = @($red | Sort-Object)
            $notified = Send-ProbeNotify -Key ("gates:" + ($sorted -join '|')) -Message (
                "Bots upstream probe: the merge with upstream $newShort is clean but $($sorted.Count) fast gate(s) fail on the merged tree: " +
                ($sorted -join ' | ') + ". Nothing was merged, built or deployed.")
        } else {
            Write-SyncLog 'probe: fast gates green on the merged tree'
        }
    }

    if (-not $notified -and $pending -ge $ProbeBacklogWarn) {
        # Bucketed so a growing backlog warns roughly once per 50 commits
        # instead of every single morning.
        $bucket = [int]([math]::Floor($pending / 50))
        $notified = Send-ProbeNotify -Key ("backlog:$bucket") -Message (
            "Bots upstream probe: $pending upstream commit(s) are waiting (upstream $newShort). The sync refuses more than $MaxCommits, so this one is heading for a manual merge.")
    }
    Save-ProbeState @{ lastResult = $result; lastUpstream = $new; lastPending = $pending; lastConflicts = @($real | Sort-Object) }
    Write-SyncLog "probe result: $result$(if (-not $notified) { ' (nothing notified)' })"
    return $result
}

# ---------------------------------------------------------------- main

New-Item -ItemType Directory -Force -Path $SyncHome | Out-Null
if (Test-Path -LiteralPath $LockFile) {
    $lock = $null
    try { $lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json } catch { $lock = $null }
    if ($lock -and (Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue)) {
        Write-Host "Another upstream sync is running (pid $($lock.pid), since $($lock.startedAt))."
        exit 0
    }
}
$isProbe = $Mode -eq 'Probe'
if ($isProbe) {
    # Probe honours the sync lock above (a running sync wins, always) but takes
    # its own, so a slow probe can never make the Saturday run exit 0 and skip
    # a week. Two probes still never overlap.
    if (Test-Path -LiteralPath $ProbeLockFile) {
        $plock = $null
        try { $plock = Get-Content -LiteralPath $ProbeLockFile -Raw | ConvertFrom-Json } catch { $plock = $null }
        if ($plock -and (Get-Process -Id ([int]$plock.pid) -ErrorAction SilentlyContinue)) {
            Write-Host "Another upstream probe is running (pid $($plock.pid), since $($plock.startedAt))."
            exit 0
        }
    }
    $script:ProbeLog = $ProbeLogFile
    Set-Content -LiteralPath $ProbeLockFile -Value (@{ pid = $PID; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json) -Encoding ASCII
} elseif (-not $PreflightOnly) {
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    $script:LogToFile = $true
    Set-Content -LiteralPath $LockFile -Value (@{ pid = $PID; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json) -Encoding ASCII
}

if ($isProbe) {
    $exitCode = 0
    Write-SyncLog "upstream probe $Stamp, sync worktree $SyncRepo"
    try {
        [void](Invoke-Probe)
    } catch {
        $detail = $_.Exception.Message
        Write-SyncLog "probe ERROR: $detail"
        [void](Send-ProbeNotify -Key ("error:" + $detail) -Message "Bots upstream probe failed before it could report anything: $detail (log $ProbeLogFile). Nothing was merged, built or deployed.")
        Save-ProbeState @{ lastResult = 'error' }
        $exitCode = 1
    } finally {
        try { Remove-ProbeScratch } catch { Write-SyncLog "probe cleanup WARNING: $($_.Exception.Message)" }
        if ($script:ProbeBefore) { try { Assert-ProbeLeftNoTrace -Before $script:ProbeBefore } catch { } }
        if (Test-Path -LiteralPath $ProbeLockFile) { Remove-Item -LiteralPath $ProbeLockFile -Force }
    }
    exit $exitCode
}

$exitCode = 0
try {
    Write-SyncLog "upstream sync $Stamp, mode $Mode$(if ($PreflightOnly) { ' (preflight only)' }), sync worktree $SyncRepo"
    Invoke-Sync
    Write-SyncLog "result: $script:StopResult"
    if (@('rolled-back', 'down', 'deployed-push-rejected') -contains $script:StopResult) { $exitCode = 1 }
} catch {
    if ($script:StopResult) {
        Write-SyncLog "stopped: $script:StopResult - $script:StopMessage"
        if (-not $PreflightOnly) {
            Save-SyncState @{ lastResult = $script:StopResult }
            $message = $script:StopMessage
            if ($script:Triage -and $script:Triage.decisions -and @($script:Triage.decisions).Count -gt 0) {
                $message = $message + "`n" + (Get-DecisionText -Decisions @($script:Triage.decisions))
            }
            Send-Notify $message
        }
    } else {
        $detail = $_.Exception.Message
        Write-SyncLog "ERROR: $detail"
        if (-not $PreflightOnly) {
            Save-SyncState @{ lastResult = 'error' }
            Send-Notify "Bots upstream sync hit an error and stopped before deploying anything it had not smoked: $detail (log $RunDir\sync.log)"
        }
    }
    $exitCode = 1
} finally {
    if (-not $PreflightOnly -and (Test-Path -LiteralPath $LockFile)) { Remove-Item -LiteralPath $LockFile -Force }
}
exit $exitCode
