<#
.SYNOPSIS
hbots release runner: ONE tested, parameterised script that replaces the per-version generated waiters
(run\restart-<ver>.ps1 patched by run\mk-waiter-*.py). Written 2026-10-11 by DevOps (task 060f3b81).

.DESCRIPTION
Modes (mutually exclusive):
  -Prepare     DevOps prep, once per release, after the builder's gate evidence and pushed notes: builds the pinned
               tools copy (git archive of scripts/personal at -MainSha), runs the notes and evidence checks, SEALS the
               staged artifact (bin.mjs, whole dist, externals, VERSION, tools tree, evidence file, helper hashes) into
               run\hbots-<ver>-seal.json, and proves the tools' backup.ps1 on a tiny fixture root + disk space.
  -GuardsOnly  Runs every guard and exits 0/1. Nothing waits, nothing restarts.
  -DryRun      Guards + one idle look + the plan with timings. Never backs up, never restarts, never notifies, never
               touches the real log/result files (writes restart-<ver>-dryrun*). With -VerifyLive and the release
               already live, also runs the post-restart verification read-only against the live server.
  (default)    The waiter: guards -> idle gate (3 looks 20 s apart) -> fresh backup + one integrity check ->
               idle recheck -> seal re-verify -> restart.ps1 -> smoke.ps1 (120 s stability) with the extended checks
               running inside that window -> log checks -> notice. Failed smoke: binary rollback + smoke. One notice.

What it replaces: the staged e2e is no longer rerun here. The builder's gate evidence ran it once on the staged
release; the seal proves the artifact that would start is byte-identical to the one the evidence ran on (and that
nothing in it is newer than the evidence start). Anything differing refuses before the idle wait and again right
before the restart.

Test overrides exist only through environment variables HBOTS_RELEASE_TEST=1 plus HBOTS_RELEASE_TEST_* (harness use;
the launcher never sets them, and a run with them says so in its result).
#>
[CmdletBinding()]
param(
    [string]$Release,
    [string]$Rollback,
    [string]$MainSha,
    [string]$Version,
    [string]$NotifyThread,
    # Max migration expected in the fresh backup (before activation) and in the live database after it.
    [string]$MigrationBefore,
    [string]$MigrationAfter,
    # Short plain text for the app sheet live line and the log: what this release changes.
    [string]$Summary = '',
    # Extra table.column names to prove after the restart (new migration columns), comma separated.
    [string]$ExtraColumns = '',
    [string]$SwRevision = '2026-09-30-worker-list',
    # Retention for the fresh PRODUCTION backup: backup.ps1 keeps the newest N timestamp-named backups (its own
    # default is 14) and prunes the rest right after writing. The old per-version waiters passed 2147483647 (no
    # pruning). 2147483647 keeps every backup. Minimum 3. The tiny fixture backup in -Prepare never prunes.
    [int]$BackupKeep = 14,
    [string]$RepoRoot = 'C:\Claude\AI\personal-bots',
    [string]$AppSheet = 'C:\Claude\AI\dev-team\apps\personal-bots.md',
    [string]$AppHistory = 'C:\Claude\AI\dev-team\apps\personal-bots-history.md',
    [switch]$Prepare,
    [switch]$GuardsOnly,
    [switch]$DryRun,
    [switch]$VerifyLive,
    # Only for -DryRun -VerifyLive: stability seconds for the read-only smoke (default 20).
    [int]$StableSeconds = 0,
    # Harness: define the functions and return.
    [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- pinned values
$PinIdleClassifierSha = 'E61B6FA57E0A5019AFDFCC1E3EC84457E1B7ADF045D8746D68BC22D1147E308D'
$PinDbCheckSha = '4B1C6170218FBC1DC04C1ABC3A1C9C6FDF798E2D756A474EC1E88DC9E0065250'
$PinTreeHashSha = '7917214BD75B56FCEF9D8C3BD244C298C12C376B38C7FB4981F972CD3C65428F'
$PinFixtureSha = '1CAFF1EAC3A7940B320029B04BFB1CEF693F98970ABD0DB8AE1296351BE991FC'
$PinPrioritySha = 'DED0E38C166B0E755941848D4A376CFBE5189D111F8ADE06B8F5C3DF0F66AC4E'
$PinConcurrencyFile = 'apps/server/src/personal/tasks/PersonalTaskService.ts'

# ---------------------------------------------------------------- paths and test overrides
$pbHome = Join-Path $env:USERPROFILE '.personal-bots'
$pbRun = Join-Path $pbHome 'run'
$pbReleases = Join-Path $pbHome 'releases'
$pbBackups = Join-Path $pbHome 'backups'
$pbLogsDir = Join-Path $pbHome 'logs'
$pbStateDir = Join-Path $pbHome 'dev\userdata'
$pbSecretsDir = Join-Path $pbStateDir 'secrets'
$pbHelpers = Join-Path $PSScriptRoot 'hbots-release'
$pbShell = Join-Path $PSHOME 'powershell.exe'
$pbTar = Join-Path $env:SystemRoot 'System32\tar.exe'

$pbTest = ($env:HBOTS_RELEASE_TEST -eq '1')
$pbClassifier = Join-Path $pbRun 'idle-classification-16617.mjs'
$pbClassifierSha = $PinIdleClassifierSha
$pbIdleSeconds = 20
$pbPort = 38472
$pbStable = 120
$pbStartTimeout = 180
if ($pbTest) {
    if ($env:HBOTS_RELEASE_TEST_CLASSIFIER) { $pbClassifier = $env:HBOTS_RELEASE_TEST_CLASSIFIER }
    if ($env:HBOTS_RELEASE_TEST_CLASSIFIER_SHA) { $pbClassifierSha = $env:HBOTS_RELEASE_TEST_CLASSIFIER_SHA }
    if ($env:HBOTS_RELEASE_TEST_IDLE_SECONDS) { $pbIdleSeconds = [int]$env:HBOTS_RELEASE_TEST_IDLE_SECONDS }
    if ($env:HBOTS_RELEASE_TEST_PORT) { $pbPort = [int]$env:HBOTS_RELEASE_TEST_PORT }
    if ($env:HBOTS_RELEASE_TEST_STABLE_SECONDS) { $pbStable = [int]$env:HBOTS_RELEASE_TEST_STABLE_SECONDS }
    if ($env:HBOTS_RELEASE_TEST_START_TIMEOUT) { $pbStartTimeout = [int]$env:HBOTS_RELEASE_TEST_START_TIMEOUT }
}

$pbMode = if ($Prepare) { 'prepare' } elseif ($GuardsOnly) { 'guards' } elseif ($DryRun) { 'dryrun' } else { 'run' }
$pbTools = Join-Path $pbRun "release-tools-$Version"
$pbToolsPs = Join-Path $pbTools 'scripts\personal'
$pbSealPath = Join-Path $pbRun "hbots-$Version-seal.json"
switch ($pbMode) {
    'run' { $pbLog = Join-Path $pbLogsDir "restart-$Version.log"; $pbResult = Join-Path $pbRun "restart-$Version-result.json" }
    'dryrun' { $pbLog = Join-Path $pbLogsDir "restart-$Version-dryrun.log"; $pbResult = Join-Path $pbRun "restart-$Version-dryrun-result.json" }
    'prepare' { $pbLog = Join-Path $pbLogsDir "restart-$Version-prepare.log"; $pbResult = Join-Path $pbRun "restart-$Version-prepare-result.json" }
    default { $pbLog = Join-Path $pbLogsDir "restart-$Version-guards.log"; $pbResult = Join-Path $pbRun "restart-$Version-guards-result.json" }
}

$StandingColumns = @(
    'personal_bot_threads.pinned_at', 'personal_bot_threads.snoozed_until', 'personal_bot_threads.marked_unread_at',
    'personal_groups.pinned_at', 'personal_groups.snoozed_until', 'personal_bots.fallback_enabled',
    'personal_bots.fallback_model_json', 'personal_bot_fallbacks.bot_id', 'personal_bot_fallbacks.reset_at',
    'personal_chat_resumes.fallback', 'personal_secret_requests.mode', 'personal_secret_requests.origins_json',
    'personal_secret_requests.placement_json', 'personal_memory.temporal_kind', 'personal_memory.observed_at',
    'personal_memory.verified_at', 'personal_memory.evidence_json', 'personal_memory.origin_thread_id',
    'personal_memory.origin_message_id', 'personal_memory.conflict'
)

# ---------------------------------------------------------------- background priority (best effort)
# Backup and integrity-check children run at CPU BelowNormal, I/O Very Low, memory Very Low so the live server's
# synchronous SQLite I/O is not starved (Backend's stall report: the 2.6 GB VACUUM INTO lines up with 23-32 s freezes).
# Only PIDs this runner started are touched; failure to lower is logged and never stops a release.
$script:BgOk = $false
try {
    $pbPrioFile = Join-Path $pbHelpers 'proc-priority.ps1'
    if ((Get-FileHash -LiteralPath $pbPrioFile -Algorithm SHA256).Hash -ine $PinPrioritySha) { throw 'proc-priority.ps1 differs from the pinned hash.' }
    . $pbPrioFile
    $script:BgOk = $true
} catch { $script:BgError = $_.Exception.Message }

# ---------------------------------------------------------------- state and logging
$script:Timings = [ordered]@{}
$pbOutcome = [ordered]@{
    runner = 'hbots-release.ps1'; mode = $pbMode; concurrency = 5; attempt = 1; status = 'starting'
    version = $Version; release = $Release; rollback = $Rollback; mainSha = $MainSha
    armedAt = (Get-Date).ToUniversalTime().ToString('o')
    idleAt = $null; activatedAt = $null; backupExit = $null; backupPath = $null
    restartExit = $null; smokeExit = $null; logErrors = $null; logWarnings = $null
    liveVersion = $null; rollbackExit = $null; rollbackSmokeExit = $null; error = $null
}
if ($pbTest) { $pbOutcome['testOverrides'] = $true }

function Note([string]$Message) {
    $dir = Split-Path -Parent $pbLog
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    "[$(Get-Date -Format s)] $Message" | Out-File -LiteralPath $pbLog -Append -Encoding utf8
    if ($pbMode -ne 'run') { Write-Host $Message }
}
function Save-Outcome {
    $pbOutcome['timings'] = $script:Timings
    $pbOutcome | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $pbResult -Encoding utf8
}
function Step([string]$Name, [scriptblock]$Body) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try { & $Body } finally {
        $script:Timings[$Name] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        Note ("step {0}: {1} s" -f $Name, $script:Timings[$Name])
    }
}
function Get-Sha([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function ConvertTo-ArgString([string[]]$Items) {
    return (($Items | ForEach-Object {
                if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            }) -join ' ')
}
function Add-LogFile([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $text = [System.IO.File]::ReadAllText($Path)
        if ($text.Trim()) { $text.TrimEnd() | Out-File -LiteralPath $pbLog -Append -Encoding utf8 }
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}
# Runs a script from the pinned tools copy as a child process; its output is appended to the log (UTF-8).
function Start-Tool([string]$Name, [string[]]$ToolArgs, [string]$Dir = $pbToolsPs, [switch]$Background) {
    $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $so = Join-Path $env:TEMP "hbots-rel-$id.out"
    $se = Join-Path $env:TEMP "hbots-rel-$id.err"
    $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Dir $Name)) + $ToolArgs
    $proc = Start-Process -FilePath $pbShell -ArgumentList (ConvertTo-ArgString $all) -NoNewWindow -PassThru `
        -RedirectStandardOutput $so -RedirectStandardError $se
    $null = $proc.Handle
    $bg = $null
    if ($Background) {
        if ($script:BgOk) { $bg = Set-HbotsBackgroundPriority $proc.Id } else { $bg = "background priority unavailable: $($script:BgError)" }
        Note "background priority for ${Name}: $bg"
    }
    return [pscustomobject]@{ Process = $proc; Out = $so; Err = $se; Name = $Name; Background = [bool]$Background }
}
function Complete-Tool($Tool) {
    if ($Tool.Background -and $script:BgOk) {
        # children (node sqlite-snapshot.cjs) inherit the lowered class; sweep anyway and record what each one runs at
        $seen = @{}
        while (-not $Tool.Process.HasExited) {
            foreach ($d in @(Get-HbotsDescendants $Tool.Process.Id)) {
                if (-not $seen.ContainsKey($d)) {
                    $seen[$d] = $true
                    Note "background priority for child of $($Tool.Name): $(Set-HbotsBackgroundPriority $d)"
                }
            }
            $null = $Tool.Process.WaitForExit(2000)
        }
    }
    $Tool.Process.WaitForExit()
    $code = [int]$Tool.Process.ExitCode
    Add-LogFile $Tool.Out
    Add-LogFile $Tool.Err
    Note "$($Tool.Name) exit=$code"
    return $code
}
function Run-PbScript([string]$Name, [string[]]$ToolArgs, [switch]$Background) {
    return (Complete-Tool (Start-Tool $Name $ToolArgs -Background:$Background))
}
# node helper: returns Code, Out, Err (stdout and stderr captured separately; nothing is echoed).
function Invoke-Node([string[]]$NodeArgs) {
    $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $so = Join-Path $env:TEMP "hbots-node-$id.out"
    $se = Join-Path $env:TEMP "hbots-node-$id.err"
    try {
        $all = @('--disable-warning=ExperimentalWarning') + $NodeArgs
        $proc = Start-Process -FilePath 'node' -ArgumentList (ConvertTo-ArgString $all) -NoNewWindow -PassThru `
            -RedirectStandardOutput $so -RedirectStandardError $se
        $null = $proc.Handle
        if ($script:BgOk) { $null = Set-HbotsBackgroundPriority $proc.Id }
        $proc.WaitForExit()
        $out = [System.IO.File]::ReadAllText($so).Trim()
        $err = [System.IO.File]::ReadAllText($se).Trim()
        return [pscustomobject]@{ Code = [int]$proc.ExitCode; Out = $out; Err = $err }
    } finally {
        Remove-Item -LiteralPath $so, $se -Force -ErrorAction SilentlyContinue
    }
}
function Get-TreeInfo([string]$Dir) {
    $r = Invoke-Node @((Join-Path $pbHelpers 'tree-hash.cjs'), $Dir)
    if ($r.Code -ne 0) { throw "tree-hash failed for ${Dir}: exit $($r.Code) $($r.Err)" }
    return ($r.Out | ConvertFrom-Json)
}
function Read-Json([string]$Path) {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}
# Raw string value of a JSON key (ConvertFrom-Json in 5.1 turns ISO strings into DateTime).
function Get-RawJsonString([string]$Path, [string]$Key) {
    $m = [regex]::Match([System.IO.File]::ReadAllText($Path), '"' + [regex]::Escape($Key) + '"\s*:\s*"([^"]*)"')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}
function ConvertTo-UtcMs([string]$Iso) {
    $dto = [DateTimeOffset]::Parse($Iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    return [int64]$dto.ToUnixTimeMilliseconds()
}
function Read-StartupLog([string]$Path, [long]$Offset) {
    $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        if ($stream.Length -lt $Offset) { throw 'Server log shrank during activation; cannot verify startup errors.' }
        $null = $stream.Seek($Offset, 'Begin')
        $reader = New-Object System.IO.StreamReader($stream)
        return ($reader.ReadToEnd() -split "`n")
    } finally { $stream.Dispose() }
}
function Get-VersionFile([string]$Sha) {
    $path = Join-Path $pbReleases "$Sha\VERSION"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Release $Sha has no VERSION file." }
    return (Get-Content -LiteralPath $path -Raw)
}

# ---------------------------------------------------------------- parameter checks
function Assert-Params {
    if ($Release -notmatch '^[0-9a-f]{12}$') { throw '-Release must be the 12-character release sha.' }
    if ($Rollback -notmatch '^[0-9a-f]{12}$') { throw '-Rollback must be the 12-character sha of the live release.' }
    if ($MainSha -notmatch '^[0-9a-f]{40}$') { throw '-MainSha must be the full 40-character sha of the pushed notes commit.' }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw '-Version must look like 1.66.31.' }
    if ($NotifyThread -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw '-NotifyThread must be the CTO chat thread id.' }
    if ($MigrationBefore -notmatch '^\d+$' -or $MigrationAfter -notmatch '^\d+$') { throw '-MigrationBefore and -MigrationAfter are required (max migration id in the backup and after activation).' }
    if ([int]$MigrationAfter -lt [int]$MigrationBefore) { throw '-MigrationAfter is lower than -MigrationBefore.' }
    if ($Release -eq $Rollback -and -not $DryRun) { throw 'Release and rollback are the same sha.' }
    if ($BackupKeep -lt 3) { throw '-BackupKeep must be at least 3 (newest timestamp backups kept by the production backup; 2147483647 keeps all).' }
    if (($Summary -match '["`$]') -or $Summary.Length -gt 400) { throw '-Summary: plain text, at most 400 characters, no quotes, backticks or $.' }
}

# ---------------------------------------------------------------- seal
function Get-VersionFields([string]$Text) {
    $f = @{}
    foreach ($key in 'version', 'release', 'dirty', 'externals') {
        $m = [regex]::Match($Text, '(?m)^' + $key + '=(\S+)\s*$')
        $f[$key] = if ($m.Success) { $m.Groups[1].Value } else { $null }
    }
    return $f
}
function Get-ArtifactFacts {
    $dir = Join-Path $pbReleases $Release
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Staged release folder $dir not found." }
    $ver = Join-Path $dir 'VERSION'
    $bin = Join-Path $dir 'dist\bin.mjs'
    $nm = Join-Path $dir 'node_modules'
    if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) { throw 'Staged release has no dist\bin.mjs.' }
    if (-not (Test-Path -LiteralPath $nm -PathType Container)) { throw 'Staged release has no node_modules (externals).' }
    $nmItem = Get-Item -LiteralPath $nm -Force
    if ($nmItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staged node_modules is a junction into a checkout: build with -CopyExternals so the release is self-contained.' }
    $fields = Get-VersionFields (Get-Content -LiteralPath $ver -Raw)
    $node = Invoke-Node @('--version')
    return [pscustomobject]@{
        Fields = $fields
        VersionFileSha = (Get-Sha $ver)
        BinSha = (Get-Sha $bin)
        Dist = (Get-TreeInfo (Join-Path $dir 'dist'))
        Externals = (Get-TreeInfo $nm)
        Tools = (Get-TreeInfo (Join-Path $pbTools 'scripts'))
        Node = $node.Out
        EvidencePath = (Join-Path $dir 'gate-evidence.json')
    }
}
function Test-ArtifactAgainst($Facts, $Expect, [string]$Label) {
    $fail = New-Object System.Collections.Generic.List[string]
    if ($Facts.Fields.version -ne $Version) { $fail.Add("VERSION file says version=$($Facts.Fields.version), expected $Version.") }
    if ($Facts.Fields.release -ne $Release) { $fail.Add("VERSION file says release=$($Facts.Fields.release), expected $Release.") }
    if ($Facts.Fields.dirty -ne 'False') { $fail.Add("VERSION file says dirty=$($Facts.Fields.dirty); a dirty build cannot ship.") }
    if ($Facts.Fields.externals -ne 'copied') { $fail.Add("VERSION file says externals=$($Facts.Fields.externals); only a -CopyExternals build ships.") }
    if ($Facts.VersionFileSha -ne $Expect.versionFileSha256) { $fail.Add('VERSION file differs from the sealed one.') }
    if ($Facts.BinSha -ne $Expect.binSha256) { $fail.Add("dist\bin.mjs differs from the sealed one ($($Facts.BinSha.Substring(0, 12)) vs $(([string]$Expect.binSha256).Substring(0, 12))).") }
    if ($Facts.Dist.sha256 -ne $Expect.dist.sha256) { $fail.Add("dist differs from the sealed manifest ($($Facts.Dist.files) files now, $($Expect.dist.files) sealed).") }
    if ($Facts.Externals.sha256 -ne $Expect.externals.sha256) { $fail.Add("externals (node_modules) differ from the sealed manifest ($($Facts.Externals.files) files now, $($Expect.externals.files) sealed).") }
    if ($Facts.Tools.sha256 -ne $Expect.tools.sha256) { $fail.Add("tools copy differs from the sealed one ($($Facts.Tools.files) files now, $($Expect.tools.files) sealed).") }
    if ($Facts.Node -ne $Expect.node) { $fail.Add("node is $($Facts.Node), the gates ran on $($Expect.node).") }
    if (-not (Test-Path -LiteralPath $Facts.EvidencePath -PathType Leaf)) {
        $fail.Add('gate-evidence.json is missing.')
    } else {
        if ((Get-Sha $Facts.EvidencePath) -ne $Expect.evidence.sha256) { $fail.Add('gate-evidence.json differs from the sealed one.') }
        $startMs = [int64]$Expect.evidence.startedAtMs
        $newest = [math]::Max([int64]$Facts.Dist.newestMtimeMs, [int64]$Facts.Externals.newestMtimeMs)
        if ($newest -gt $startMs) { $fail.Add("something in dist or node_modules is newer than the evidence start ($($Expect.evidence.startedAtIso)): the artifact changed after the gates started.") }
        $verItem = Get-Item -LiteralPath (Join-Path (Join-Path $pbReleases $Release) 'VERSION')
        $vm = ([DateTimeOffset]$verItem.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        if ($vm -gt $startMs) { $fail.Add('VERSION is newer than the evidence start.') }
    }
    return $fail
}
function Test-SealFile {
    if (-not (Test-Path -LiteralPath $pbSealPath -PathType Leaf)) { throw "No seal at $pbSealPath. Run hbots-release.ps1 -Prepare for this release first." }
    $seal = Read-Json $pbSealPath
    $fail = New-Object System.Collections.Generic.List[string]
    if ($seal.schema -ne 1) { $fail.Add("seal schema $($seal.schema), expected 1.") }
    if ($seal.version -ne $Version) { $fail.Add("seal is for version $($seal.version).") }
    if ($seal.release -ne $Release) { $fail.Add("seal is for release $($seal.release).") }
    if ($seal.mainSha -ne $MainSha) { $fail.Add("seal is for notes commit $($seal.mainSha).") }
    if ($seal.rollback -ne $Rollback) { $fail.Add("seal was made with rollback $($seal.rollback).") }
    if ($fail.Count -gt 0) { throw ('Seal does not match this run: ' + ($fail -join ' ')) }
    $facts = Get-ArtifactFacts
    $problems = Test-ArtifactAgainst $facts $seal 'seal'
    if ($problems.Count -gt 0) { throw ('Staged artifact is not the sealed one: ' + (($problems | Select-Object -First 6) -join ' ')) }
    return $seal
}

# ---------------------------------------------------------------- guards
function Test-PinnedHelpers {
    if ((Get-Sha $pbClassifier) -ne $pbClassifierSha.ToLowerInvariant()) { throw 'Reviewed idle classifier changed.' }
    foreach ($pair in @(@('release-db-check.cjs', $PinDbCheckSha), @('tree-hash.cjs', $PinTreeHashSha), @('make-fixture.cjs', $PinFixtureSha), @('proc-priority.ps1', $PinPrioritySha))) {
        $p = Join-Path $pbHelpers $pair[0]
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "Helper $($pair[0]) missing." }
        if ((Get-Sha $p) -ne ([string]$pair[1]).ToLowerInvariant()) { throw "Helper $($pair[0]) differs from the pinned hash." }
    }
}
function Test-ConcurrencyRule {
    $r = & git -C $RepoRoot show "${MainSha}:$PinConcurrencyFile" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Cannot read $PinConcurrencyFile at $MainSha to prove PERSONAL_TASKS_CONCURRENCY = 5." }
    if (-not (($r -join "`n") -match '(?m)PERSONAL_TASKS_CONCURRENCY\s*=\s*5\b')) { throw "PERSONAL_TASKS_CONCURRENCY is not 5 at $MainSha (Harout's rule: at most 5 at once in total)." }
}
function Get-NewestBackupBytes {
    $b = Get-ChildItem -LiteralPath $pbBackups -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $b) { return 0 }
    $m = Get-ChildItem -LiteralPath $b.FullName -Recurse -File -Force | Measure-Object Length -Sum
    return [int64]$m.Sum
}
function Test-DiskSpace {
    $newest = Get-NewestBackupBytes
    $liveDb = (Get-Item -LiteralPath (Join-Path $pbStateDir 'state.sqlite') -ErrorAction SilentlyContinue)
    $liveBytes = if ($liveDb) { [int64]$liveDb.Length } else { 0 }
    $need = [int64][math]::Max([math]::Max($newest * 2.5, $liveBytes * 2.5), 2GB)
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $pbBackups).Path)
    $free = (New-Object System.IO.DriveInfo($root)).AvailableFreeSpace
    $pbOutcome['diskFreeBytes'] = $free
    $pbOutcome['diskNeededBytes'] = $need
    if ($free -lt $need) { throw "Not enough disk space for the backup on ${root}: $([math]::Round($free / 1GB, 1)) GB free, $([math]::Round($need / 1GB, 1)) GB needed." }
}
# Proves, on a tiny fixture root, that the copied tools' backup.ps1 (sqlite-snapshot.cjs, common.ps1) works and that
# release-db-check.cjs reads the result. Replaces the full preflight production backup.
function Test-ToolsFixtureBackup {
    $fx = Join-Path $env:TEMP ("hbots-fixture-{0}-{1}" -f $Version, [guid]::NewGuid().ToString('N').Substring(0, 8))
    $previousProfile = $env:USERPROFILE
    try {
        $state = Join-Path $fx '.personal-bots\dev\userdata'
        New-Item -ItemType Directory -Force -Path (Join-Path $state 'attachments') | Out-Null
        $mk = Invoke-Node @((Join-Path $pbHelpers 'make-fixture.cjs'), (Join-Path $state 'state.sqlite'), $MigrationBefore)
        if ($mk.Code -ne 0) { throw "fixture database failed: $($mk.Err)" }
        Set-Content -LiteralPath (Join-Path $state 'attachments\a.txt') -Value 'fixture' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $state 'settings.json') -Value '{}' -Encoding ASCII
        $env:USERPROFILE = $fx
        $code = Run-PbScript 'backup.ps1' @('-Root', 'dev', '-Keep', '2147483647') -Background
        $env:USERPROFILE = $previousProfile
        if ($code -ne 0) { throw "tools backup.ps1 failed on the fixture root (exit $code): the copied tools are incomplete." }
        $made = @(Get-ChildItem -LiteralPath (Join-Path $fx '.personal-bots\backups') -Directory)
        if ($made.Count -ne 1) { throw 'fixture backup did not produce exactly one backup.' }
        $snap = Join-Path $made[0].FullName 'state.sqlite'
        if (-not (Test-Path -LiteralPath $snap)) { throw 'fixture backup has no state.sqlite.' }
        if (-not (Test-Path -LiteralPath (Join-Path $made[0].FullName 'backup.json'))) { throw 'fixture backup has no backup.json.' }
        # The same proof check the waiter runs on the production backup, so tools that publish no proof fail here.
        $chk = Invoke-Node @((Join-Path $pbHelpers 'release-db-check.cjs'), $snap, '--verified-backup')
        if ($chk.Code -ne 0) { throw "release-db-check --verified-backup failed on the fixture backup: $($chk.Err)" }
        $j = $chk.Out | ConvertFrom-Json
        if ($j.ic -ne 'ok' -or [int]$j.mig -ne [int]$MigrationBefore) { throw "fixture backup check unexpected: $($chk.Out)" }
    } finally {
        $env:USERPROFILE = $previousProfile
        if ((Test-Path -LiteralPath $fx) -and $fx.StartsWith($env:TEMP) -and ($fx -like '*hbots-fixture-*')) {
            Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
function Test-NoOtherRunner {
    if ($pbTest) { return }
    $self = $PID
    $others = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $self -and $_.Name -match '^powershell' -and $_.CommandLine -and
            ($_.CommandLine -match 'restart-\d+\.\d+\.\d+(-attempt\d+)?\.ps1' -or
            ($_.CommandLine -match 'hbots-release\.ps1' -and $_.CommandLine -notmatch '-(DryRun|Prepare|GuardsOnly)\b'))
        })
    if ($others.Count -gt 0) { throw "Another waiter is running: PID $(($others | ForEach-Object { $_.ProcessId }) -join ',')." }
}
function Test-ActiveRelease([switch]$AllowTarget) {
    $cur = (Get-Content -LiteralPath (Join-Path $pbReleases 'current.txt') -Raw).Trim()
    $st = Read-Json (Join-Path $pbRun 'server.json')
    $ok = @($Rollback)
    if ($AllowTarget) { $ok += $Release }
    if ($ok -notcontains $cur -or $ok -notcontains [string]$st.release) {
        throw "Active release changed (current.txt=$cur, server.json=$($st.release)); expected the live baseline $Rollback. Not activating."
    }
    return $cur
}
function Invoke-Guards {
    Step 'guards.pinned-helpers' { Test-PinnedHelpers }
    Step 'guards.seal-and-artifact' { $script:Seal = Test-SealFile }
    Step 'guards.concurrency-rule' { Test-ConcurrencyRule }
    $pbOutcome.status = 'notes_check'; Save-Outcome
    Step 'guards.notes-check' {
        $pbOutcome['notesExit'] = Run-PbScript 'check-release-notes.ps1' @('-Version', $Version, '-Commit', $MainSha, '-RepoRoot', $RepoRoot)
        if ($pbOutcome['notesExit'] -ne 0) { throw "check-release-notes.ps1 -Version $Version exited $($pbOutcome['notesExit']); not arming the restart (nothing was restarted). Finish docs/releases/HANDOFF-<ver>.md, push it, and re-arm. See the log." }
    }
    $pbOutcome.status = 'evidence_check'; Save-Outcome
    Step 'guards.evidence-check' {
        $pbOutcome['evidenceExit'] = Run-PbScript 'check-gate-evidence.ps1' @('-Version', $Version, '-Release', $Release, '-Commit', $MainSha, '-RepoRoot', $RepoRoot)
        if ($pbOutcome['evidenceExit'] -ne 0) { throw "check-gate-evidence.ps1 -Release $Release exited $($pbOutcome['evidenceExit']); not arming the restart (nothing was restarted). Run gate-evidence.ps1 on the staged release, commit the notes (docs/releases only), push, and re-arm. See the log." }
    }
    $pbOutcome.status = 'preflight'; Save-Outcome
    Step 'guards.tools-fixture-backup' { Test-ToolsFixtureBackup }
    Step 'guards.disk-space' { Test-DiskSpace }
    Step 'guards.active-release' { $null = Test-ActiveRelease -AllowTarget:$DryRun }
    if ($pbMode -eq 'run') { Step 'guards.no-other-waiter' { Test-NoOtherRunner } }
    $pbOutcome['e2eSource'] = 'gate-evidence (builder run, bound to the sealed artifact)'
    $pbOutcome['sealSha256'] = (Get-Sha $pbSealPath)
}

# ---------------------------------------------------------------- idle gate
function Get-IdleLook {
    $r = Invoke-Node @($pbClassifier)
    $text = $r.Out
    if (-not $text -and $r.Err) { $text = "classifier error: $($r.Err)" }
    return [pscustomobject]@{ Code = $r.Code; Text = $text; Idle = ($r.Code -eq 0 -and $r.Out -eq 'idle') }
}
function Wait-Idle {
    $deadline = (Get-Date).AddHours(48)
    $streak = 0
    $last = ''
    while ($streak -lt 3) {
        if ((Get-Date) -gt $deadline) { throw "Still busy after 48 hours ($last); not restarted." }
        $look = Get-IdleLook
        if ($look.Idle) { $streak++ } else { $streak = 0 }
        if ($look.Text -ne $last) { Note $look.Text; $last = $look.Text }
        if ($streak -lt 3) { Start-Sleep -Seconds $pbIdleSeconds }
    }
}

# ---------------------------------------------------------------- post-activation verification
function Get-HttpStatusOrContent([string]$Uri, [string]$Method = 'GET') {
    try {
        if ($Method -eq 'POST') {
            $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0 -Method Post -ContentType 'application/json' -Body '{}' -Uri $Uri
        } else {
            $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri $Uri
        }
        $body = $resp.Content
        if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
        return [pscustomobject]@{ Status = [int]$resp.StatusCode; Content = [string]$body }
    } catch {
        if ($_.Exception.Response) { return [pscustomobject]@{ Status = [int]$_.Exception.Response.StatusCode; Content = '' } }
        throw
    }
}
# A: everything that does not need the whole stability window; runs while smoke.ps1 waits its 120 s.
function Invoke-ChecksA([hashtable]$Ctx) {
    $base = "http://127.0.0.1:$pbPort"
    $deadline = (Get-Date).AddSeconds($pbStartTimeout)
    $ready = $false
    do {
        try {
            $st = Read-Json (Join-Path $pbRun 'server.json')
            if ([string]$st.release -eq $Release) {
                $v = Get-HttpStatusOrContent "$base/version.txt"
                if ($v.Status -eq 200) { $ready = $true; break }
            }
        } catch { }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $ready) { throw "Server did not serve $Release on $pbPort within $pbStartTimeout s." }
    $cur = (Get-Content -LiteralPath (Join-Path $pbReleases 'current.txt') -Raw).Trim()
    $after = Read-Json (Join-Path $pbRun 'server.json')
    $ver = (Get-HttpStatusOrContent "$base/version.txt").Content
    $exp = $Ctx.ExpVersion
    if ($cur -ne $Release -or [string]$after.release -ne $Release -or $ver -notmatch ('(?m)^version=' + [regex]::Escape($exp) + '\s*$') -or $ver -notmatch ('(?m)^release=' + [regex]::Escape($Release) + '\s*$')) {
        throw "Current/server/version.txt disagree with $exp/$Release target."
    }
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $pbPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($listeners.Count -ne 1) { throw "Expected one loopback listener on $pbPort; found $($listeners.Count)." }
    $ident = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0])"
    if (-not $ident -or $ident.Name -ine 'node.exe') { throw 'Loopback server listener is not node.exe.' }
    if ([int]$ident.ParentProcessId -ne [int]$after.pid) { throw "Listener parent $($ident.ParentProcessId) differs from tracked wrapper $($after.pid)." }
    $proc = Get-Process -Id ([int]$listeners[0]) -ErrorAction Stop
    $pbOutcome['serverNodePid'] = [int]$listeners[0]
    $pbOutcome['serverWrapperPid'] = [int]$after.pid
    $pbOutcome['serverPriority'] = [string]$proc.PriorityClass
    if ($pbOutcome['serverPriority'] -ne 'AboveNormal') { throw "Server priority=$($pbOutcome['serverPriority']); expected AboveNormal." }
    Note "Server priority PASS: listener 127.0.0.1:$pbPort node.exe PID=$($pbOutcome['serverNodePid']), parent=$($pbOutcome['serverWrapperPid']), priority=AboveNormal, active release=$($after.release)."
    $sw = (Get-HttpStatusOrContent "$base/sw.js").Content
    if ($sw -notmatch [regex]::Escape($SwRevision)) { throw "Live service worker lacks the $SwRevision revision." }
    $sent = Get-HttpStatusOrContent "$base/api/personal/push/sent" 'POST'
    $pbOutcome['sentUnauthenticatedStatus'] = $sent.Status
    if ($sent.Status -ne 401) { throw "Unauthenticated POST /api/personal/push/sent returned $($sent.Status); expected 401." }
    Note 'Unauthenticated POST /api/personal/push/sent returned 401.'
    $cols = @($StandingColumns)
    if ($ExtraColumns) { $cols += @($ExtraColumns -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $liveDb = Join-Path $pbStateDir 'state.sqlite'
    $env:PB_CHECK_DB = $liveDb
    $env:PB_CHECK_COLUMNS = ($cols -join ',')
    try { $mig = Invoke-Node @((Join-Path $pbToolsPs 'migration-check.cjs')) } finally { $env:PB_CHECK_DB = $null; $env:PB_CHECK_COLUMNS = $null }
    if ($mig.Code -ne 0) { throw "Migration check failed: $($mig.Err)" }
    $migJson = $mig.Out | ConvertFrom-Json
    $pbOutcome['migrationCheck'] = $migJson
    if ([int]$migJson.maxMigration -ne [int]$MigrationAfter) { throw "Live database migration level is $($migJson.maxMigration); expected $MigrationAfter." }
    foreach ($c in $migJson.columns.PSObject.Properties) { if (-not $c.Value) { throw "Migration column $($c.Name) missing." } }
    # one release-db-check on the live database: integrity, activity rows, memory rows, migration
    $dbc = Invoke-Node @((Join-Path $pbHelpers 'release-db-check.cjs'), $liveDb)
    if ($dbc.Code -ne 0) { throw "Live release-db-check failed: $($dbc.Err)" }
    $live = $dbc.Out | ConvertFrom-Json
    if ($live.ic -ne 'ok') { throw "Live integrity_check: $($live.ic)" }
    if ([int]$live.mig -ne [int]$MigrationAfter) { throw "Live release-db-check migration $($live.mig); expected $MigrationAfter." }
    $pbOutcome['liveMemoryRows'] = [int]$live.mem
    Note "Migration check: max=$($migJson.maxMigration); integrity $($live.ic)."
    if ($null -ne $Ctx.BackupMemoryRows) {
        if ([int]$live.mem -lt [int]$Ctx.BackupMemoryRows) { throw "Memory rows dropped: backup had $($Ctx.BackupMemoryRows), live has $($live.mem)." }
        Note "Memory rows: backup $($Ctx.BackupMemoryRows), live $($live.mem) (no row lost)."
    }
    $sealed = 0; $unsealed = 0
    $magic = [System.Text.Encoding]::ASCII.GetBytes('T3SEC1')
    foreach ($f in @(Get-ChildItem -LiteralPath $pbSecretsDir -Filter 'personal-secret-*.bin' -File -Force -ErrorAction SilentlyContinue)) {
        $head = New-Object byte[] 6
        $s = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
        try { $n = $s.Read($head, 0, 6) } finally { $s.Dispose() }
        if ($n -eq 6 -and [System.Linq.Enumerable]::SequenceEqual([byte[]]$head, [byte[]]$magic)) { $sealed++ } else { $unsealed++ }
    }
    $pbOutcome['secretKeyFilesSealed'] = $sealed
    $pbOutcome['secretKeyFilesNotSealed'] = $unsealed
    Note "Saved key files: $sealed sealed, $unsealed not sealed (counts only)."
}
# B: needs the finished window: log scans from the restart offset, then the relay.
function Invoke-ChecksB([hashtable]$Ctx) {
    $lines = @(Read-StartupLog $Ctx.ServerLog $Ctx.LogByte)
    $text = $lines -join "`n"
    $tok = @($lines | Where-Object { $_ -match 'Token:|Pairing URL' })
    $pbOutcome['tokenOrPairingLines'] = $tok.Count
    if ($tok.Count -gt 0) { throw "Server log since restart has $($tok.Count) Token:/Pairing URL lines." }
    Note 'No Token:/Pairing URL lines in the server log since restart.'
    if (-not $Ctx.SkipStartupMarker) {
        if ($text -notmatch '(?s)stall recorder on.{0,200}profiler:\s*''continuous''') { throw 'Stall recorder continuous-profiler startup marker absent.' }
        $pbOutcome['stallRecorderOn'] = $true
        $pbOutcome['stallProfilerMode'] = 'continuous'
    }
    if ($text -match '(?i)stall watchdog error|profiler.{0,60}(?:error|failed)|(?:error|failed).{0,60}profiler') { throw 'Watchdog/profiler error in startup log.' }
    $pbOutcome['sqliteBusyLines'] = @($lines | Where-Object { $_ -match 'SQLITE_BUSY|database is locked' }).Count
    $pbOutcome['usageLines'] = @($lines | Where-Object { $_ -match 'usage' }).Count
    $pbOutcome['shadowedLines'] = @($lines | Where-Object { $_ -match 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' }).Count
    $pbOutcome['researchCallLines'] = @($lines | Where-Object { $_ -match 'personal research call' } | Select-Object -First 20)
    $pbOutcome['relayLines'] = @($lines | Where-Object { $_ -match '(?i)relay|tunnel' }).Count
    $pbOutcome['relayRegisteredLines'] = @($lines | Where-Object { $_ -match '(?i)regist' -and $_ -match '(?i)relay|tunnel' }).Count
    # The slow-SQL stall notes echo statements that mention a column called "error" ('sql 790 ms INSERT INTO
    # orchestration_command_receipts (... status, error) ...'); those echoes are not errors. Every other line counts.
    $errors = @($lines | Where-Object { $_ -notmatch "^\s*'sql \d+ ms " } | Where-Object { $_ -match '\bERROR\b|\bFATAL\b|MigrationError|SqlError|SQLITE_ERROR|Defect in' })
    $pbOutcome.logErrors = $errors.Count
    $pbOutcome.logWarnings = @($lines | Where-Object { $_ -match '\bWARN\b|Warning:' }).Count
    if ($pbOutcome.logErrors -gt 0) { throw "Startup log has $($pbOutcome.logErrors) error lines; review $($Ctx.ServerLog) from byte $($Ctx.LogByte)." }
    if ($pbOutcome.shadowedLines -gt 0) { throw 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED after restart.' }
    $after = Read-Json (Join-Path $pbRun 'server.json')
    $nodeExe = (Get-Command node).Source
    $raw = (& $nodeExe ([string]$after.binPath) connect status --json --base-dir ([string]$after.baseDir) 2>$null) -join "`n"
    $start = $raw.IndexOf('{')
    if ($start -lt 0) { throw 'Phone relay status JSON missing.' }
    $relay = $raw.Substring($start) | ConvertFrom-Json
    if (-not $relay.linked -or -not $relay.endpointUrl) { throw 'Phone relay did not reconnect.' }
    $uri = ([string]$relay.endpointUrl).TrimEnd('/') + '/.well-known/t3/environment'
    try { $rh = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri $uri } catch { throw 'Phone relay health request failed after landing.' }
    if ($rh.StatusCode -ne 200) { throw 'Phone relay health returned non-200.' }
    $pbOutcome['phoneRelayReconnected'] = $true
    $pbOutcome['phoneRelayHttpStatus'] = 200
    Note 'Phone relay reconnected: linked=true and remote environment HTTP 200.'
}
# smoke.ps1 runs as a child while the A checks run in this process; B runs after smoke has passed.
function Invoke-PostActivation([hashtable]$Ctx, [int]$StableSec) {
    $smokeArgs = @('-ExpectRelease', $Release, '-LogFromByte', "$($Ctx.LogByte)", '-LogFile', $Ctx.ServerLog, '-StartTimeoutSeconds', "$pbStartTimeout", '-StableSeconds', "$StableSec")
    $smoke = Start-Tool 'smoke.ps1' $smokeArgs
    $aError = $null
    $swA = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Ctx.RestartExit -eq 0) {
        try { Invoke-ChecksA $Ctx } catch { $aError = $_.Exception.Message }
    } else {
        $aError = "Restart exit $($Ctx.RestartExit)"
    }
    $script:Timings['post.checks-A-during-smoke'] = [math]::Round($swA.Elapsed.TotalSeconds, 1)
    $swS = [System.Diagnostics.Stopwatch]::StartNew()
    $smokeExit = Complete-Tool $smoke
    $script:Timings['post.smoke-remaining-wait'] = [math]::Round($swS.Elapsed.TotalSeconds, 1)
    $result = [pscustomobject]@{ SmokeExit = $smokeExit; Error = $null }
    if ($smokeExit -eq 0) {
        if ($aError) {
            $result.SmokeExit = 1; $result.Error = $aError
        } else {
            try {
                $swB = [System.Diagnostics.Stopwatch]::StartNew()
                Invoke-ChecksB $Ctx
                $script:Timings['post.checks-B'] = [math]::Round($swB.Elapsed.TotalSeconds, 1)
            } catch { $result.SmokeExit = 1; $result.Error = $_.Exception.Message }
        }
        if ($result.SmokeExit -ne 0) { Note "Extended smoke FAIL: $($result.Error)" }
    }
    return $result
}

# ---------------------------------------------------------------- rollback, notice, sheet
function Invoke-Rollback {
    $pbOutcome.status = 'rolling_back'; Save-Outcome
    $pbOutcome.rollbackExit = Run-PbScript 'restart.ps1' @('-Release', $Rollback, '-NoPrune')
    $pbOutcome.rollbackSmokeExit = Run-PbScript 'smoke.ps1' @('-ExpectRelease', $Rollback)
    $pbOutcome.status = if ($pbOutcome.rollbackExit -eq 0 -and $pbOutcome.rollbackSmokeExit -eq 0) { 'rolled_back' } else { 'rollback_failed' }
    Save-Outcome
}
function Update-AppSheet([string]$SummaryLine) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $doc = [System.IO.File]::ReadAllText($AppSheet)
    if ($doc -match ('\*\*v' + [regex]::Escape($Version) + '\*\* live since')) {
        Note 'App sheet already shows this version; not touched.'
        return
    }
    $nl = if ($doc.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [string[]]($doc -split "`r?`n")
    $old = $lines[2]
    if ($old -notmatch '\*\*v\d+\.\d+\.\d+\*\* live since') { throw 'App sheet line 3 is not the live line; live checks passed but the update needs review.' }
    $prefix = $old.Substring(0, $old.IndexOf('**v'))
    $tailAt = $old.IndexOf(' Release logs and old live lines:')
    $tail = if ($tailAt -ge 0) { $old.Substring($tailAt) } else { ' Release logs and old live lines: `apps/personal-bots-history.md`.' }
    $hist = [System.IO.File]::ReadAllText($AppHistory)
    if (-not $hist.Contains($old)) {
        $hnl = if ($hist.Contains("`r`n")) { "`r`n" } else { "`n" }
        $hl = [string[]]($hist -split "`r?`n")
        $at = [Array]::IndexOf($hl, '## 1. Old live line (was line 3)')
        if ($at -lt 0) { throw 'History file has no "## 1. Old live line (was line 3)" heading; live checks passed but the update needs review.' }
        $new = @($hl[0..($at + 1)]) + @($old, '') + @($hl[($at + 2)..($hl.Count - 1)])
        [System.IO.File]::WriteAllText($AppHistory, ($new -join $hnl), $utf8)
    }
    $lines[2] = $prefix + $SummaryLine + $tail
    [System.IO.File]::WriteAllText($AppSheet, ($lines -join $nl), $utf8)
    if ([System.IO.File]::ReadAllLines($AppSheet)[2] -notmatch ('\*\*v' + [regex]::Escape($Version) + '\*\* live since')) { throw 'App sheet line 3 did not take the new live line.' }
}
function Send-ReleaseNotice {
    $outcome = switch ($pbOutcome.status) {
        'live_verified' { 'live' }
        'live_verified_doc_update_failed' { 'live' }
        'rolled_back' { 'rolled_back' }
        'rollback_failed' { 'rollback_failed' }
        default { 'failed' }
    }
    try {
        $a = @('-ThreadId', $NotifyThread, '-Version', $Version, '-Release', $Release, '-Outcome', $outcome, '-LogPath', $pbLog)
        $smoke = if ($null -ne $pbOutcome.smokeExit) { [string]$pbOutcome.smokeExit } else { '-1' }
        $a += @('-SmokeExit', $smoke)
        if ($outcome -in @('rolled_back', 'rollback_failed')) {
            $a += @('-RollbackRelease', $Rollback)
            if ($null -ne $pbOutcome.rollbackExit) { $a += @('-RollbackExit', [string]$pbOutcome.rollbackExit) }
            if ($null -ne $pbOutcome.rollbackSmokeExit) { $a += @('-RollbackSmokeExit', [string]$pbOutcome.rollbackSmokeExit) }
        }
        if ($pbOutcome.error) { $a += @('-Detail', ([string]$pbOutcome.error -replace '["`]', "'")) }
        $pbOutcome['notifyExit'] = Run-PbScript 'notify-release.ps1' $a
        $pbOutcome['notifyOutcome'] = $outcome
        Save-Outcome
    } catch {
        Note "Release notice FAILED: $($_.Exception.Message)"
        $pbOutcome['notifyExit'] = 1
        $pbOutcome['notifyError'] = $_.Exception.Message
        Save-Outcome
    }
}

# ---------------------------------------------------------------- prepare
function Invoke-Prepare {
    Assert-Params
    Step 'prepare.pinned-helpers' { Test-PinnedHelpers }
    Step 'prepare.tools-copy' {
        $tmp = Join-Path $env:TEMP ("hbots-tools-{0}-{1}" -f $Version, [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        try {
            $tarFile = Join-Path $tmp 'a.tar'
            $x = Join-Path $tmp 'x'
            New-Item -ItemType Directory -Force -Path $x | Out-Null
            & git -C $RepoRoot archive --format=tar -o $tarFile $MainSha 'scripts/personal'
            if ($LASTEXITCODE -ne 0) { throw "git archive of scripts/personal at $MainSha failed (is the commit fetched?)." }
            & $pbTar -xf $tarFile -C $x
            if ($LASTEXITCODE -ne 0) { throw 'tar extract failed.' }
            $fresh = Get-TreeInfo (Join-Path $x 'scripts')
            if (Test-Path -LiteralPath $pbTools) {
                $have = Get-TreeInfo (Join-Path $pbTools 'scripts')
                if ($have.sha256 -ne $fresh.sha256) { throw "Existing $pbTools differs from git archive of $MainSha ($($have.files) vs $($fresh.files) files). Remove that folder (a plain copy, no junctions) and run -Prepare again." }
                Note "Tools copy $pbTools already matches git archive of $MainSha ($($fresh.files) files)."
            } else {
                New-Item -ItemType Directory -Force -Path $pbTools | Out-Null
                Copy-Item -LiteralPath (Join-Path $x 'scripts') -Destination $pbTools -Recurse -Force
                Note "Tools copy written: $pbTools ($($fresh.files) files, whole scripts/personal tree of $MainSha)."
            }
            $script:ToolsFiles = $fresh.files
        } finally {
            if ((Test-Path -LiteralPath $tmp) -and ($tmp -like '*hbots-tools-*')) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    $pbOutcome.status = 'notes_check'; Save-Outcome
    Step 'prepare.notes-check' {
        $c = Run-PbScript 'check-release-notes.ps1' @('-Version', $Version, '-Commit', $MainSha, '-RepoRoot', $RepoRoot)
        if ($c -ne 0) { throw "check-release-notes.ps1 exited $c." }
    }
    Step 'prepare.evidence-check' {
        $c = Run-PbScript 'check-gate-evidence.ps1' @('-Version', $Version, '-Release', $Release, '-Commit', $MainSha, '-RepoRoot', $RepoRoot)
        if ($c -ne 0) { throw "check-gate-evidence.ps1 exited $c." }
    }
    Step 'prepare.concurrency-rule' { Test-ConcurrencyRule }
    $facts = $null
    Step 'prepare.seal' {
        $script:facts = Get-ArtifactFacts
        $f = $script:facts
        $evidence = Read-Json $f.EvidencePath
        # top-level startedAt/finishedAt sit before "gates"; read them raw (5.1 turns ISO strings into DateTime)
        $rawEvidence = [System.IO.File]::ReadAllText($f.EvidencePath)
        $cut = $rawEvidence.IndexOf('"gates"')
        $head = if ($cut -gt 0) { $rawEvidence.Substring(0, $cut) } else { $rawEvidence }
        $sm = [regex]::Match($head, '"startedAt"\s*:\s*"([^"]+)"')
        $fm = [regex]::Match($head, '"finishedAt"\s*:\s*"([^"]+)"')
        if (-not $sm.Success) { throw 'gate-evidence.json has no top-level startedAt.' }
        $started = $sm.Groups[1].Value
        $finished = if ($fm.Success) { $fm.Groups[1].Value } else { $null }
        if ([string]$evidence.binSha256 -ne $f.BinSha) { throw 'gate-evidence binSha256 differs from the staged dist\bin.mjs.' }
        $e2e = @($evidence.gates | Where-Object { $_.id -eq 'e2e' })
        if ($e2e.Count -ne 1) { throw 'gate-evidence has no single e2e gate.' }
        $cmd = [string](@($e2e[0].commands)[0].command)
        if ($cmd -notmatch ('releases[\\/]' + $Release + '\b')) { throw "The evidence e2e gate did not run on releases\$Release ($cmd)." }
        $problems = @()
        $seal = [ordered]@{
            schema = 1; version = $Version; release = $Release; mainSha = $MainSha; rollback = $Rollback
            sealedAt = (Get-Date).ToUniversalTime().ToString('o')
            node = $f.Node
            versionFileSha256 = $f.VersionFileSha
            binSha256 = $f.BinSha
            dist = $f.Dist
            externals = $f.Externals
            tools = [ordered]@{ dir = $pbTools; files = $f.Tools.files; sha256 = $f.Tools.sha256 }
            evidence = [ordered]@{
                sha256 = (Get-Sha $f.EvidencePath); commit = [string]$evidence.sha; startedAtIso = $started; startedAtMs = (ConvertTo-UtcMs $started); finishedAtIso = $finished
                e2eJourneys = [int]$e2e[0].counts.journeys; e2ePassed = [int]$e2e[0].counts.passed; e2eCommand = $cmd
            }
            helpers = [ordered]@{ idleClassifierSha256 = $pbClassifierSha.ToLowerInvariant(); dbCheckSha256 = $PinDbCheckSha.ToLowerInvariant() }
        }
        $problems = Test-ArtifactAgainst $f ([pscustomobject]$seal) 'new seal'
        if ($problems.Count -gt 0) { throw ('Cannot seal: ' + ($problems -join ' ')) }
        $seal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $pbSealPath -Encoding utf8
        Note "Seal written: $pbSealPath (dist $($f.Dist.files) files, externals $($f.Externals.files) files, tools $($f.Tools.files) files, e2e $($e2e[0].counts.passed)/$($e2e[0].counts.journeys) journeys in the evidence)."
        $pbOutcome['sealSha256'] = (Get-Sha $pbSealPath)
    }
    Step 'prepare.tools-fixture-backup' { Test-ToolsFixtureBackup }
    Step 'prepare.disk-space' { Test-DiskSpace }
    $pbOutcome.status = 'prepared'; Save-Outcome
}

# ---------------------------------------------------------------- main
if ($LibraryOnly) { return }

try {
    $totalSw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($pbMode -eq 'prepare') {
        Invoke-Prepare
        Note "PREPARED $Version ($Release) in $([math]::Round($totalSw.Elapsed.TotalSeconds, 1)) s. Next: -DryRun, then the launcher when the CTO steers SHIP."
        exit 0
    }

    Assert-Params
    Note "Runner $pbMode for $Version ($Release), rollback $Rollback, notes commit $MainSha$(if ($pbTest) { ' [TEST OVERRIDES]' })."
    if ($pbMode -eq 'run' -and $Summary) { Note "CTO-cleared ${Version}: $Summary Migration $MigrationBefore -> $MigrationAfter. Require 3 idle checks ${pbIdleSeconds} seconds apart, fresh integrity-checked backup, idle recheck, sealed-artifact activation, smoke with extended checks and binary rollback only." }
    $pbOutcome.status = 'guards'; Save-Outcome
    Invoke-Guards

    if ($pbMode -eq 'guards') {
        $pbOutcome.status = 'guards_ok'; Save-Outcome
        Note "All guards passed in $([math]::Round($totalSw.Elapsed.TotalSeconds, 1)) s."
        exit 0
    }

    if ($pbMode -eq 'dryrun') {
        $look = $null
        Step 'idle.one-look' { $script:look = Get-IdleLook }
        $pbOutcome['idleLook'] = $script:look.Text
        Note "Idle classifier now: $($script:look.Text) (a real run needs 3 idle looks $pbIdleSeconds s apart)."
        $active = Test-ActiveRelease -AllowTarget
        $pbOutcome['activeRelease'] = $active
        if ($VerifyLive) {
            if ($active -eq $Release) {
                $stable = if ($StableSeconds -gt 0) { $StableSeconds } else { 20 }
                $srv = Read-Json (Join-Path $pbRun 'server.json')
                $logFile = [string]$srv.logFile
                $len = (Get-Item -LiteralPath $logFile).Length
                $ctx = @{ ExpVersion = $Version; ServerLog = $logFile; LogByte = [math]::Max(0, $len - 65536); RestartExit = 0; BackupMemoryRows = $null; SkipStartupMarker = $true }
                $pbOutcome.status = 'verify_live'; Save-Outcome
                Step 'verifylive.post-activation (smoke+checks)' {
                    $script:pa = Invoke-PostActivation $ctx $stable
                }
                $pbOutcome.smokeExit = $script:pa.SmokeExit
                if ($script:pa.SmokeExit -ne 0) { $pbOutcome.error = if ($script:pa.Error) { $script:pa.Error } else { "smoke exit $($script:pa.SmokeExit)" }; throw "VerifyLive failed: $($pbOutcome.error)" }
            } else {
                Note "VerifyLive skipped: active release is $active, not $Release."
            }
        }
        $pbOutcome.status = 'dryrun_ok'
        Save-Outcome
        Note ''
        Note "DRY RUN OK for $Version ($Release): every guard passed; backup, restart and notice were NOT run."
        foreach ($k in $script:Timings.Keys) { Note ("  {0,-48} {1,7} s" -f $k, $script:Timings[$k]) }
        $totalLabel = 'TOTAL this dry run (guards + one idle look' + $(if ($VerifyLive) { ' + live verify' } else { '' }) + ')'
        Note ("  {0,-48} {1,7} s" -f $totalLabel, [math]::Round($totalSw.Elapsed.TotalSeconds, 1))
        $guardSeconds = 0.0
        foreach ($k in $script:Timings.Keys) { if ($k -like 'guards.*') { $guardSeconds += [double]$script:Timings[$k] } }
        $planned = [ordered]@{
            'idle gate: 3 looks 20 s apart (fixed)' = 40
            'fresh backup: online copy, digest/read-ahead and ONE full check (3.04 GB copy)' = 160
            'backup proof: SHA-256 re-read (full integrity already completed)' = 2
            'seal re-verify + idle recheck' = 6
            'restart.ps1 (recent range 9-21 s)' = 15
            'smoke.ps1 120 s stability window (extended checks A run inside it)' = 123
            'checks B (log scans, relay) + sheet + notice' = 6
        }
        $tsBackups = @(Get-ChildItem -LiteralPath $pbBackups -Directory -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match '^\d{8}-\d{6}$' -and -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'backup.json') -PathType Leaf)
        } | Sort-Object Name -Descending)
        $wouldPrune = @($tsBackups | Select-Object -Skip ([math]::Max(0, [int][math]::Min([int64]$BackupKeep - 1, [int]::MaxValue))))
        $pbOutcome['backupKeep'] = $BackupKeep
        $pbOutcome['backupsWouldPrune'] = @($wouldPrune | ForEach-Object { $_.Name })
        Note "Backup retention: $($tsBackups.Count) timestamp backups now; the fresh one makes $($tsBackups.Count + 1); -BackupKeep $BackupKeep would prune $($wouldPrune.Count)$(if ($wouldPrune.Count) { ': ' + (($wouldPrune | ForEach-Object { $_.Name }) -join ', ') })."
        Save-Outcome
        Note 'Not run in a dry run (they need idle and a restart); copy benchmark estimates, not a production SLA:'
        $sum = $guardSeconds
        foreach ($k in $planned.Keys) { Note ("  {0,-70} {1,5} s" -f $k, $planned[$k]); $sum += $planned[$k] }
        Note ("  {0,-70} {1,5} s  (= {2} min; 1.66.30 took 731 s = 12.2 min at normal priority)" -f 'EXPECTED arm -> verified, idle from the start', [math]::Round($sum), [math]::Round($sum / 60, 1))
        exit 0
    }

    # ---- real run ----
    $pbOutcome.status = 'waiting_for_idle'; Save-Outcome
    Step 'idle.wait' { Wait-Idle }
    $pbOutcome.idleAt = (Get-Date).ToUniversalTime().ToString('o')
    $null = Test-ActiveRelease
    Note "Idle confirmed; backup then activation -> $Release"
    $pbOutcome.status = 'backing_up'; Save-Outcome
    $backupStart = (Get-Date).ToUniversalTime()
    $existing = @(Get-ChildItem -LiteralPath $pbBackups -Directory | ForEach-Object { $_.Name })
    Test-DiskSpace
    Step 'backup.production' {
        $pbOutcome.backupExit = Run-PbScript 'backup.ps1' @('-Root', 'dev', '-Keep', [string]$BackupKeep) -Background
        if ($pbOutcome.backupExit -ne 0) { throw 'Backup failed; not restarting. See the log.' }
    }
    $pruned = @($existing | Where-Object { $_ -match '^\d{8}-\d{6}$' -and -not (Test-Path -LiteralPath (Join-Path $pbBackups $_)) })
    $pbOutcome['backupKeep'] = $BackupKeep
    $pbOutcome['backupsPruned'] = $pruned
    Note "Backup retention: newest $BackupKeep kept; pruned $($pruned.Count)$(if ($pruned.Count) { ': ' + ($pruned -join ', ') })."
    $fresh = @(Get-ChildItem -LiteralPath $pbBackups -Directory | Where-Object { $_.Name -notin $existing -and $_.Name -match '^\d{8}-\d{6}$' })
    if ($fresh.Count -ne 1) { throw 'Cannot identify exactly one fresh backup; not restarting.' }
    $pbOutcome.backupPath = $fresh[0].FullName
    $manifestPath = Join-Path $pbOutcome.backupPath 'backup.json'
    $manifest = Read-Json $manifestPath
    $createdRaw = Get-RawJsonString $manifestPath 'createdAt'
    if ($manifest.root -ne 'dev' -or -not $createdRaw -or (ConvertTo-UtcMs $createdRaw) -lt ([DateTimeOffset]$backupStart).ToUnixTimeMilliseconds()) { throw 'Backup manifest does not match this activation; not restarting.' }
    Step 'backup.verify (one release-db-check)' {
        $r = Invoke-Node @((Join-Path $pbHelpers 'release-db-check.cjs'), (Join-Path $pbOutcome.backupPath 'state.sqlite'), '--verified-backup')
        if ($r.Code -ne 0) { throw "Backup check failed: $($r.Err)" }
        $script:bk = $r.Out | ConvertFrom-Json
    }
    $bk = $script:bk
    if ($bk.ic -ne 'ok') { throw "Backup integrity_check: $($bk.ic)" }
    if ([int]$bk.mig -ne [int]$MigrationBefore) { throw "Backup is at migration $($bk.mig); expected exactly $MigrationBefore." }
    $pbOutcome['backupMaxMigration'] = [int]$bk.mig
    $pbOutcome['backupActivityRows'] = [int]$bk.rows
    $pbOutcome['backupMemoryRows'] = [int]$bk.mem
    Note "Verified fresh backup: $($pbOutcome.backupPath) (max migration $($bk.mig), integrity ok, activity rows $($bk.rows), memory rows $($bk.mem))"
    Save-Outcome
    $look = Get-IdleLook
    if (-not $look.Idle) { throw "Work resumed during backup ($($look.Text)); not restarting. Re-arm after reviewing the log." }
    $null = Test-ActiveRelease
    Step 'seal.reverify-before-restart' { $null = Test-SealFile }
    $before = Read-Json (Join-Path $pbRun 'server.json')
    $serverLog = [string]$before.logFile
    $logByte = (Get-Item -LiteralPath $serverLog).Length
    $pbOutcome.status = 'activating'; Save-Outcome
    $swRestart = [System.Diagnostics.Stopwatch]::StartNew()
    $pbOutcome.restartExit = Run-PbScript 'restart.ps1' @('-Release', $Release, '-NoPrune')
    $script:Timings['restart'] = [math]::Round($swRestart.Elapsed.TotalSeconds, 1)
    try {
        $afterState = Read-Json (Join-Path $pbRun 'server.json')
        $pbOutcome.activatedAt = Get-RawJsonString (Join-Path $pbRun 'server.json') 'startedAt'
        if ([string]$afterState.logFile -ne $serverLog) { $serverLog = [string]$afterState.logFile; $logByte = 0 }
        $pbOutcome['serverLog'] = $serverLog
        $pbOutcome['logFromByte'] = $logByte
    } catch { Note 'Server state unavailable after restart; smoke will verify startup.' }
    $pbOutcome.status = 'smoking'; Save-Outcome
    $ctx = @{ ExpVersion = $Version; ServerLog = $serverLog; LogByte = $logByte; RestartExit = $pbOutcome.restartExit; BackupMemoryRows = $bk.mem; SkipStartupMarker = $false }
    $pa = $null
    Step 'post.activation (smoke + checks)' { $script:pa = Invoke-PostActivation $ctx $pbStable }
    $pa = $script:pa
    $pbOutcome.smokeExit = $pa.SmokeExit
    if ($pa.Error) { $pbOutcome.error = $pa.Error }
    if ($pbOutcome.smokeExit -eq 0 -and $pbOutcome.restartExit -eq 0) { $pbOutcome.liveVersion = $Version }
    if ($pbOutcome.smokeExit -eq 0 -and $pbOutcome.restartExit -ne 0) { $pbOutcome.smokeExit = 1; $pbOutcome.error = "Restart exit $($pbOutcome.restartExit)" }
    Save-Outcome
    if ($pbOutcome.smokeExit -ne 0) {
        if (-not $pbOutcome.error) {
            $failure = @(Get-Content -LiteralPath $pbLog | Where-Object { $_ -match '^\s*FAIL\s|Smoke FAILED' })
            $pbOutcome.error = if ($failure.Count -gt 0) { ([string]$failure[0]).Trim() } else { "Release smoke failed, exit $($pbOutcome.smokeExit). Exact failure is in $pbLog." }
        }
        Note "Smoke FAILED: $($pbOutcome.error). Rolling back binary -> $Rollback."
        Invoke-Rollback
        exit 1
    }
    $pbOutcome.status = 'live_verified'; Save-Outcome
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('GMT Standard Time')
    $localUtc = ([DateTimeOffset]::Parse([string]$pbOutcome.activatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)).UtcDateTime
    $localStart = [TimeZoneInfo]::ConvertTimeFromUtc($localUtc, $zone).ToString('yyyy-MM-dd HH:mm:ss')
    $zoneName = if ($zone.IsDaylightSavingTime($localUtc)) { 'BST' } else { 'GMT' }
    $what = if ($Summary) { $Summary } else { "see docs/releases/HANDOFF-$($Version -replace '\.', '').md" }
    $line = "**v$Version** live since $localStart $zoneName (release $Release; $what; gate evidence PASS (e2e run once by the builder, artifact sealed); externals copied; concurrency 5; pushed docs $MainSha; runner hbots-release.ps1; backup $($pbOutcome.backupPath), migration $MigrationBefore -> $MigrationAfter, integrity ok; backup/restart/smoke $($pbOutcome.backupExit)/$($pbOutcome.restartExit)/$($pbOutcome.smokeExit); version/current/server agree; unauthenticated push/sent 401; relay HTTP 200; startup ERROR=0; rollback $Rollback retained, binary only)."
    $swSheet = [System.Diagnostics.Stopwatch]::StartNew()
    Update-AppSheet $line
    $script:Timings['sheet-update'] = [math]::Round($swSheet.Elapsed.TotalSeconds, 1)
    $pbOutcome['armToVerifiedSeconds'] = [math]::Round($totalSw.Elapsed.TotalSeconds, 1)
    Note "Done: live_verified in $($pbOutcome['armToVerifiedSeconds']) s from start. App sheet line 3 replaced; the old line 3 is at the top of the history file."
    Save-Outcome
    exit 0
} catch {
    $pbOutcome.error = $_.Exception.Message
    if ($pbOutcome.status -eq 'live_verified') {
        $pbOutcome.status = 'live_verified_doc_update_failed'
    } elseif ($pbOutcome.status -in @('activating', 'smoking')) {
        if ($null -eq $pbOutcome.smokeExit) { $pbOutcome.smokeExit = 1 }
        try { Invoke-Rollback } catch {
            $pbOutcome.status = 'rollback_failed'
            Note "Rollback exception: $($_.Exception.Message)"
        }
    } elseif ($pbOutcome.status -eq 'rolling_back') {
        $pbOutcome.status = 'rollback_failed'
    } else {
        $pbOutcome.status = 'failed'
    }
    Note "FAILED: $($pbOutcome.error)"
    Save-Outcome
    exit 1
} finally {
    if ($pbMode -eq 'run' -and -not $LibraryOnly) { Send-ReleaseNotice }
}
