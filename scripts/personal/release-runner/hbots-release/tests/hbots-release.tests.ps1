# End-to-end harness for run\hbots-release.ps1: drives the REAL runner against a fake home (USERPROFILE override),
# a throwaway git repo that carries the real backup.ps1/common.ps1/sqlite-snapshot.cjs/migration-check.cjs plus stub
# restart/smoke/notify/check scripts, and a stub HTTP server. Nothing touches the real ~/.personal-bots.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File hbots-release.tests.ps1 [-Only s1,s2]
param([string[]]$Only = @(), [string]$ToolsDir)
$ErrorActionPreference = 'Stop'
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$here = $PSScriptRoot
$runner = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'hbots-release.ps1'
$realTools = if ($ToolsDir) { (Resolve-Path -LiteralPath $ToolsDir).Path } else { (Resolve-Path (Join-Path $here '..\..\..')).Path }
if (-not (Test-Path (Join-Path $realTools 'backup.ps1'))) { throw 'Pass -ToolsDir pointing to the new scripts/personal tree.' }
$stubs = Join-Path $here 'stubs'
$realProfile = $env:USERPROFILE
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Passed = 0
$Rel = 'aaaaaaaaaaaa'
$Rb = 'bbbbbbbbbbbb'
$Ver = '9.9.9'
$Thread = '11111111-2222-3333-4444-555555555555'

# the standing column list comes from the runner itself
$libOut = & powershell -NoProfile -ExecutionPolicy Bypass -Command "& { . '$runner' -LibraryOnly; (`$StandingColumns -join ',') }"
$StandingCsv = ($libOut | Select-Object -Last 1).Trim()
if (-not $StandingCsv) { throw 'could not read the standing columns from the runner' }

function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { $script:Passed++; Write-Host "  ok    $Name" }
    else { $script:Failures.Add("$Name $Detail"); Write-Host "  FAIL  $Name $Detail" }
}
function Get-FreePort {
    for ($i = 0; $i -lt 50; $i++) {
        $p = Get-Random -Minimum 39200 -Maximum 39900
        if (-not (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)) { return $p }
    }
    throw 'no free port'
}
function Write-File([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-TestGit([string]$Repo, [string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Repo -c user.email=test@example.invalid -c user.name=harness -c commit.gpgsign=false -c core.safecrlf=false @GitArgs 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) { throw "git $($GitArgs -join ' ') failed: $out" }
    return $out
}

function New-World([string]$Name, [string]$Concurrency = '5') {
    $root = Join-Path $env:TEMP ("hbots-reltest-{0}-{1}" -f $Name, [guid]::NewGuid().ToString('N').Substring(0, 6))
    $h = Join-Path $root '.personal-bots'
    $port = Get-FreePort
    foreach ($d in 'run\flags', 'releases', 'backups', 'logs', 'dev\userdata\secrets', 'dev\userdata\attachments') { New-Item -ItemType Directory -Force -Path (Join-Path $h $d) | Out-Null }
    # git repo with the tools tree
    $repo = Join-Path $root 'repo'
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'scripts\personal'), (Join-Path $repo 'apps\server\src\personal\tasks'), (Join-Path $repo 'docs\releases') | Out-Null
    foreach ($f in 'common.ps1', 'backup.ps1', 'sqlite-snapshot.cjs', 'sqlite-check.cjs', 'migration-check.cjs') { Copy-Item -LiteralPath (Join-Path $realTools $f) -Destination (Join-Path $repo "scripts\personal\$f") }
    foreach ($f in 'check-release-notes.ps1', 'check-gate-evidence.ps1', 'restart.ps1', 'smoke.ps1', 'notify-release.ps1') { Copy-Item -LiteralPath (Join-Path $stubs $f) -Destination (Join-Path $repo "scripts\personal\$f") }
    Write-File (Join-Path $repo 'apps\server\src\personal\tasks\PersonalTaskService.ts') "export const PERSONAL_TASKS_CONCURRENCY = $Concurrency;`n"
    Write-File (Join-Path $repo 'docs\releases\HANDOFF-999.md') "notes`n"
    $null = & git -C $repo init -q
    $null = Invoke-TestGit $repo @('add', '-A')
    $null = Invoke-TestGit $repo @('commit', '-q', '-m', 'harness')
    $main = (Invoke-TestGit $repo @('rev-parse', 'HEAD') | Select-Object -First 1).ToString().Trim()
    # releases
    foreach ($pair in @(@($Rel, '9.9.9'), @($Rb, '9.9.8'))) {
        $sha = $pair[0]
        $rd = Join-Path $h "releases\$sha"
        Write-File (Join-Path $rd 'dist\bin.mjs') ("// $sha`nconsole.log(JSON.stringify({linked:true,endpointUrl:'http://127.0.0.1:$port'}));`n")
        Write-File (Join-Path $rd 'dist\client\index.html') "<html>$sha</html>"
        Write-File (Join-Path $rd 'dist\client\assets\index-abc.js') "console.log('$sha')"
        Write-File (Join-Path $rd 'node_modules\pkg\index.js') "module.exports = 1;"
        Write-File (Join-Path $rd 'VERSION') "version=$($pair[1])`nrelease=$sha`nsha=$sha`nbranch=harness`ndirty=False`nbuiltAt=2026-01-01T00:00:00Z`nexternals=copied`n"
    }
    Write-File (Join-Path $h 'releases\current.txt') $Rb
    # gate evidence for the target (startedAt in the future relative to the files just written)
    $started = (Get-Date).ToUniversalTime().AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $binSha = Sha256 (Join-Path $h "releases\$Rel\dist\bin.mjs")
    $ev = [ordered]@{
        schema = 1; version = $Ver; release = $Rel; sha = ($Rel + ('0' * 28)); treeClean = $true; headAtStart = ($Rel + ('0' * 28)); headAtEnd = ($Rel + ('0' * 28))
        binSha256 = $binSha; startedAt = $started; finishedAt = $started; ok = $true
        gates = @([ordered]@{ id = 'e2e'; kind = 'e2e'; exit = 0; commands = @([ordered]@{ command = "powershell -File e2e-smoke.ps1 -Release `"$h\releases\$Rel`" -Json"; exit = 0 }); counts = [ordered]@{ journeys = 12; passed = 12; failed = 0 } })
    }
    Write-File (Join-Path $h "releases\$Rel\gate-evidence.json") ($ev | ConvertTo-Json -Depth 8)
    # live database + secrets + server log + server.json
    $us = Join-Path $h 'dev\userdata'
    & node --disable-warning=ExperimentalWarning (Join-Path $stubs 'mk-live-db.cjs') (Join-Path $us 'state.sqlite') 104 $StandingCsv
    if ($LASTEXITCODE -ne 0) { throw 'live db fixture failed' }
    [System.IO.File]::WriteAllBytes((Join-Path $us 'secrets\personal-secret-1.bin'), ([System.Text.Encoding]::ASCII.GetBytes('T3SEC1') + [byte[]](1, 2, 3, 4)))
    Write-File (Join-Path $us 'settings.json') '{}'
    $log = Join-Path $h 'logs\server-test.log'
    Write-File $log "[old] INFO nothing interesting`n"
    # the fake server (cmd wrapper -> node), AboveNormal like the real one
    $cmd = Start-Process -FilePath cmd.exe -ArgumentList '/c', "node `"$(Join-Path $stubs 'fake-server.cjs')`" `"$h`" $port" -PassThru -WindowStyle Hidden
    $nodePid = $null
    for ($i = 0; $i -lt 40 -and -not $nodePid; $i++) {
        Start-Sleep -Milliseconds 250
        $c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { $nodePid = [int]$c.OwningProcess }
    }
    if (-not $nodePid) { throw 'fake server did not start' }
    (Get-Process -Id $nodePid).PriorityClass = 'AboveNormal'
    $sj = [ordered]@{ pid = $cmd.Id; release = $Rb; binPath = (Join-Path $h "releases\$Rb\dist\bin.mjs"); baseDir = (Join-Path $h 'dev'); startedAt = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o'); logFile = $log; root = 'dev' }
    Write-File (Join-Path $h 'run\server.json') ($sj | ConvertTo-Json)
    # sheet + history
    $oldLine = 'The app you are running in. **v9.9.8** live since 2026-01-01 00:00:00 GMT (release bbbbbbbbbbbb; old). Release logs and old live lines: `apps/personal-bots-history.md`.'
    Write-File (Join-Path $root 'sheet.md') "# personal-bots`n`n$oldLine`n`n## Status`n"
    Write-File (Join-Path $root 'history.md') "# history`n`n## 1. Old live line (was line 3)`n`nolder stuff`n"
    return @{
        Name = $Name; Root = $root; Home = $h; Run = (Join-Path $h 'run'); Flags = (Join-Path $h 'run\flags'); Repo = $repo; Main = $main
        Port = $port; CmdPid = $cmd.Id; NodePid = $nodePid; Sheet = (Join-Path $root 'sheet.md'); History = (Join-Path $root 'history.md')
        Log = (Join-Path $h "logs\restart-$Ver.log"); OldLine = $oldLine
    }
}
function Remove-World($w) {
    foreach ($id in @($w.NodePid, $w.CmdPid)) { if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
    $r = $w.Root
    if ((Test-Path -LiteralPath $r) -and $r.StartsWith($env:TEMP) -and $r -like '*hbots-reltest-*') {
        Start-Sleep -Milliseconds 500
        Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue
    }
}
function Set-Flag($w, [string]$Name, [string]$Value = '1') { Write-File (Join-Path $w.Flags $Name) $Value }
function Clear-Flag($w, [string]$Name) { Remove-Item -LiteralPath (Join-Path $w.Flags $Name) -Force -ErrorAction SilentlyContinue }
function Get-Calls($w) {
    $p = Join-Path $w.Flags 'calls.log'
    if (Test-Path $p) { return @(Get-Content -LiteralPath $p) }
    return @()
}
function Reset-Calls($w) {
    foreach ($n in 'calls.log', 'idle-pos.txt') { Clear-Flag $w $n }
}
function Get-Result($w, [string]$Suffix = '') {
    $p = Join-Path $w.Run "restart-$Ver$Suffix-result.json"
    if (Test-Path $p) { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) }
    return $null
}
function Invoke-Runner($w, [string[]]$Extra, [hashtable]$Param = @{}) {
    $p = [ordered]@{
        Release = $Rel; Rollback = $Rb; MainSha = $w.Main; Version = $Ver; NotifyThread = $Thread
        MigrationBefore = '104'; MigrationAfter = '104'; Summary = 'harness change'; RepoRoot = $w.Repo
        AppSheet = $w.Sheet; AppHistory = $w.History
    }
    foreach ($k in $Param.Keys) { $p[$k] = $Param[$k] }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner)
    foreach ($k in $p.Keys) { $argList += @("-$k", [string]$p[$k]) }
    $argList += $Extra
    $envKeep = @{}
    $set = @{
        USERPROFILE = $w.Root; HBOTS_RELEASE_TEST = '1'; HBOTS_TEST_FLAGS = $w.Flags; HBOTS_TEST_PORT = "$($w.Port)"; HBOTS_TEST_STUBS = $stubs
        HBOTS_RELEASE_TEST_PORT = "$($w.Port)"; HBOTS_RELEASE_TEST_IDLE_SECONDS = '1'; HBOTS_RELEASE_TEST_STABLE_SECONDS = '6'
        HBOTS_RELEASE_TEST_START_TIMEOUT = '30'; HBOTS_RELEASE_TEST_CLASSIFIER = (Join-Path $stubs 'idle-stub.mjs')
        HBOTS_RELEASE_TEST_CLASSIFIER_SHA = ((Get-FileHash -LiteralPath (Join-Path $stubs 'idle-stub.mjs') -Algorithm SHA256).Hash)
    }
    foreach ($k in $set.Keys) { $envKeep[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $set[$k]) }
    try {
        $so = Join-Path $env:TEMP ("hbots-rt-{0}.out" -f [guid]::NewGuid().ToString('N').Substring(0, 6))
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $proc = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList (($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ') -NoNewWindow -Wait -PassThru -RedirectStandardOutput $so
        $out = if (Test-Path $so) { [System.IO.File]::ReadAllText($so) } else { '' }
        Remove-Item -LiteralPath $so -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Exit = [int]$proc.ExitCode; Out = $out; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    } finally {
        foreach ($k in $set.Keys) { [Environment]::SetEnvironmentVariable($k, $envKeep[$k]) }
    }
}
function Prepare-World($w) {
    $r = Invoke-Runner $w @('-Prepare')
    if ($r.Exit -ne 0) { throw "Prepare failed in world $($w.Name): $($r.Out)" }
    return $r
}
function Calls-Of($w, [string]$Prefix) { return @(Get-Calls $w | Where-Object { $_ -like "$Prefix*" }) }
function Backups-Count($w) { return @(Get-ChildItem -LiteralPath (Join-Path $w.Home 'backups') -Directory -ErrorAction SilentlyContinue).Count }
function Current($w) { return (Get-Content -LiteralPath (Join-Path $w.Home 'releases\current.txt') -Raw).Trim() }

function Should-Run([string]$Id) { return ($Only.Count -eq 0 -or $Only -contains $Id) }

# ------------------------------------------------------------------ scenarios
function Scenario-Happy {
    Write-Host '== s1 happy path: prepare, idle streak reset, backup, activate, smoke with checks A in the window, sheet, notice'
    $w = New-World 'happy'
    try {
        $prep = Prepare-World $w
        Assert (Test-Path (Join-Path $w.Run "hbots-$Ver-seal.json")) 'prepare wrote the seal'
        Assert (Test-Path (Join-Path $w.Run "release-tools-$Ver\scripts\personal\backup.ps1")) 'prepare built the tools copy'
        $again = Invoke-Runner $w @('-Prepare')
        Assert ($again.Exit -eq 0) 'prepare is repeatable (tools copy matches git archive)'
        Reset-Calls $w
        Set-Flag $w 'idle-seq.txt' "idle`nbusy`nidle`nidle`nidle"
        Set-Flag $w 'sql-echo'
        $r = Invoke-Runner $w @()
        $res = Get-Result $w
        Write-Host "     runner exit=$($r.Exit) in $($r.Seconds) s, status=$($res.status)"
        Assert ($r.Exit -eq 0) 'runner exit 0' $r.Out
        Assert ($res.status -eq 'live_verified') 'status live_verified' "($($res.status): $($res.error))"
        Assert ((Current $w) -eq $Rel) 'current.txt is the target'
        $idle = @(Calls-Of $w 'idle-look')
        Assert ($idle.Count -ge 6) 'idle streak reset by the busy look (5 waiting looks + 1 recheck)' "(looks: $($idle.Count))"
        $restarts = @(Calls-Of $w 'restart')
        Assert ($restarts.Count -eq 1 -and $restarts[0] -eq "restart $Rel") 'exactly one restart, to the target' ($restarts -join ';')
        Assert ((Calls-Of $w 'notes').Count -eq 1 -and (Calls-Of $w 'evidence').Count -eq 1) 'notes and evidence checked once'
        $note = @(Calls-Of $w 'notify')
        Assert ($note.Count -eq 1 -and $note[0] -match 'outcome=live' -and $note[0] -match "thread=$Thread") 'one notice, outcome live, to the CTO thread' ($note -join ';')
        Assert ((Backups-Count $w) -eq 1) 'one production backup taken (fixture backup lives elsewhere)'
        Assert ($res.backupMaxMigration -eq 104 -and $res.backupMemoryRows -eq 8) 'backup verified by the single db check'
        Assert ($res.liveMemoryRows -eq 8 -and $res.sentUnauthenticatedStatus -eq 401) 'live checks ran (memory rows, push/sent 401)'
        Assert ($res.serverPriority -eq 'AboveNormal') 'server priority checked'
        Assert ($res.logErrors -eq 0 -and $res.tokenOrPairingLines -eq 0) 'startup log clean (sql echo ignored)'
        Assert ($res.PSObject.Properties.Name -contains 'phoneRelayReconnected' -and $res.phoneRelayReconnected) 'relay check ran'
        Assert ($res.armToVerifiedSeconds -gt 0) 'armToVerifiedSeconds recorded'
        $sheet = (Get-Content -LiteralPath $w.Sheet)[2]
        Assert ($sheet -match '\*\*v9\.9\.9\*\* live since') 'sheet line 3 updated'
        Assert ((Get-Content -LiteralPath $w.History -Raw) -match 'v9\.9\.8') 'old line moved to history'
        $smoke = @(Calls-Of $w 'smoke')
        Assert ($smoke.Count -eq 1 -and $smoke[0] -match 'stable=6') 'smoke ran once with the stability window'
        $bgLines = @(Get-Content -LiteralPath $w.Log | Where-Object { $_ -match 'background priority' })
        Assert ($bgLines.Count -ge 1 -and ($bgLines -join ' ') -match 'io=VeryLow') 'backup ran lowered (cpu BelowNormal, io VeryLow)' ($bgLines -join ' | ')
    } finally { Remove-World $w }
}
function Scenario-Rollbacks {
    foreach ($case in @(
            @{ Id = 'smoke'; Flag = "smoke.$Rel.exit"; Val = '1'; Why = 'smoke exit 1' },
            @{ Id = 'errorline'; Flag = 'error-line'; Val = '1'; Why = 'ERROR line in startup log' },
            @{ Id = 'tokenline'; Flag = 'token-line'; Val = '1'; Why = 'Pairing URL line in log' },
            @{ Id = 'memory'; Flag = 'drop-memory'; Val = '1'; Why = 'memory rows dropped' },
            @{ Id = 'priority'; Flag = 'normal-priority'; Val = '1'; Why = 'server priority Normal' },
            @{ Id = 'push'; Flag = 'push-open'; Val = '1'; Why = 'push/sent not 401' },
            @{ Id = 'restartfail'; Flag = "restart.$Rel.exit"; Val = '3'; Why = 'restart.ps1 exit 3' })) {
        if (-not (Should-Run "s2-$($case.Id)")) { continue }
        Write-Host "== s2 rollback: $($case.Why)"
        $w = New-World "rb-$($case.Id)"
        try {
            $null = Prepare-World $w
            Reset-Calls $w
            Set-Flag $w $case.Flag $case.Val
            $r = Invoke-Runner $w @()
            $res = Get-Result $w
            Write-Host "     runner exit=$($r.Exit) in $($r.Seconds) s, status=$($res.status), error=$($res.error)"
            Assert ($r.Exit -eq 1) 'runner exit 1'
            Assert ($res.status -eq 'rolled_back') 'status rolled_back' "($($res.status))"
            Assert ((Current $w) -eq $Rb) 'current.txt back on the baseline'
            $restarts = @(Calls-Of $w 'restart')
            Assert ($restarts.Count -eq 2 -and $restarts[0] -eq "restart $Rel" -and $restarts[1] -eq "restart $Rb") 'restart target then restart baseline (binary only)' ($restarts -join ';')
            $note = @(Calls-Of $w 'notify')
            Assert ($note.Count -eq 1 -and $note[0] -match 'outcome=rolled_back' -and $note[0] -match "rollback=$Rb") 'one notice, outcome rolled_back' ($note -join ';')
            Assert ($res.rollbackExit -eq 0 -and $res.rollbackSmokeExit -eq 0) 'rollback restart and smoke exit 0'
            $sheet = (Get-Content -LiteralPath $w.Sheet)[2]
            Assert ($sheet -match 'v9\.9\.8') 'sheet untouched after a rollback'
        } finally { Remove-World $w }
    }
}
function Scenario-Refusals {
    Write-Host '== s3 guard refusals: nothing may restart, one failed notice each'
    $w = New-World 'refuse'
    try {
        $null = Prepare-World $w
        $relDir = Join-Path $w.Home "releases\$Rel"
        $variants = @(
            @{ Id = 'bin'; Tamper = { Write-File (Join-Path $relDir 'dist\bin.mjs') "// tampered`n" }; Restore = $null; Want = 'bin.mjs differs' },
            @{ Id = 'dist-add'; Tamper = { Write-File (Join-Path $relDir 'dist\client\assets\extra.js') 'x' }; Restore = { Remove-Item (Join-Path $relDir 'dist\client\assets\extra.js') -Force }; Want = 'dist differs' },
            @{ Id = 'dist-edit'; Tamper = { Write-File (Join-Path $relDir 'dist\client\index.html') '<html>changed</html>' }; Restore = $null; Want = 'dist differs' },
            @{ Id = 'externals'; Tamper = { Write-File (Join-Path $relDir 'node_modules\pkg\index.js') 'module.exports = 2;' }; Restore = $null; Want = 'externals' },
            @{ Id = 'evidence'; Tamper = { Add-Content -LiteralPath (Join-Path $relDir 'gate-evidence.json') -Value ' ' }; Restore = $null; Want = 'gate-evidence.json differs' },
            @{ Id = 'version'; Tamper = { Add-Content -LiteralPath (Join-Path $relDir 'VERSION') -Value 'extra=1' }; Restore = $null; Want = 'VERSION' },
            @{ Id = 'tools'; Tamper = { Add-Content -LiteralPath (Join-Path $w.Run "release-tools-$Ver\scripts\personal\smoke.ps1") -Value '# edited' }; Restore = $null; Want = 'tools copy differs' },
            @{ Id = 'notes'; Tamper = { Set-Flag $w 'notes.exit' '1' }; Restore = { Clear-Flag $w 'notes.exit' }; Want = 'check-release-notes' },
            @{ Id = 'evidence-check'; Tamper = { Set-Flag $w 'evidence.exit' '1' }; Restore = { Clear-Flag $w 'evidence.exit' }; Want = 'check-gate-evidence' },
            @{ Id = 'wrong-baseline'; Tamper = { Write-File (Join-Path $w.Home 'releases\current.txt') $Rel }; Restore = { Write-File (Join-Path $w.Home 'releases\current.txt') $Rb }; Want = 'Active release changed' }
        )
        foreach ($v in $variants) {
            Reset-Calls $w
            & $v.Tamper
            $r = Invoke-Runner $w @()
            $res = Get-Result $w
            Assert ($r.Exit -eq 1 -and $res.status -eq 'failed') "[$($v.Id)] refused, status failed" "(exit $($r.Exit) status $($res.status) error=$($res.error))"
            Assert (([string]$res.error) -match [regex]::Escape($v.Want)) "[$($v.Id)] error names the cause" "(error: $($res.error))"
            Assert ((Calls-Of $w 'restart').Count -eq 0) "[$($v.Id)] nothing restarted"
            Assert ((Backups-Count $w) -eq 0) "[$($v.Id)] no production backup taken"
            Assert ((Calls-Of $w 'notify').Count -eq 1 -and @(Calls-Of $w 'notify')[0] -match 'outcome=failed') "[$($v.Id)] one failed notice"
            if ($v.Restore) { & $v.Restore }
            elseif ($v.Id -in 'bin', 'dist-edit', 'externals', 'evidence', 'version', 'tools') {
                # re-prepare would refuse tampered inputs; rebuild the world for the next variant
                Remove-World $w
                $w = New-World 'refuse'
                $null = Prepare-World $w
                $relDir = Join-Path $w.Home "releases\$Rel"
            }
        }
        # mtime newer than the evidence start, with identical bytes (a rebuild that produced the same files)
        Reset-Calls $w
        (Get-Item -LiteralPath (Join-Path $relDir 'dist\client\index.html')).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(1)
        $r = Invoke-Runner $w @()
        $res = Get-Result $w
        Assert ($r.Exit -eq 1 -and ([string]$res.error) -match 'newer than the evidence start') '[mtime] file newer than the evidence start refused' "(error: $($res.error))"
        Assert ((Calls-Of $w 'restart').Count -eq 0) '[mtime] nothing restarted'
    } finally { Remove-World $w }
}
function Scenario-ParamGuards {
    Write-Host '== s4 parameter and seal-binding guards'
    $w = New-World 'params'
    try {
        $null = Prepare-World $w
        $cases = @(
            @{ Id = 'other-main'; Param = @{ MainSha = ('c' * 40) }; Want = 'seal is for notes commit' },
            @{ Id = 'other-rollback'; Param = @{ Rollback = 'dddddddddddd' }; Want = 'seal was made with rollback' },
            @{ Id = 'same-sha'; Param = @{ Rollback = $Rel }; Want = 'same sha' },
            @{ Id = 'bad-thread'; Param = @{ NotifyThread = 'nope' }; Want = 'NotifyThread' },
            @{ Id = 'bad-migration'; Param = @{ MigrationBefore = 'abc' }; Want = 'MigrationBefore' },
            @{ Id = 'dollar-summary'; Param = @{ Summary = 'costs $5 now' }; Want = 'Summary' },
            @{ Id = 'keep-too-low'; Param = @{ BackupKeep = '2' }; Want = 'BackupKeep' }
        )
        foreach ($c in $cases) {
            Reset-Calls $w
            $r = Invoke-Runner $w @() $c.Param
            Assert ($r.Exit -eq 1) "[$($c.Id)] refused" $r.Out
            Assert ((Calls-Of $w 'restart').Count -eq 0) "[$($c.Id)] nothing restarted"
            $res = Get-Result $w
            Assert (([string]$res.error) -match [regex]::Escape($c.Want)) "[$($c.Id)] error names the cause" "(error: $($res.error))"
        }
    } finally { Remove-World $w }
}
function Scenario-DbExpectations {
    foreach ($case in @(
            @{ Id = 'before'; Param = @{ MigrationBefore = '103'; MigrationAfter = '104' }; Status = 'failed'; Restarts = 0; Want = 'expected exactly 103' },
            @{ Id = 'after'; Param = @{ MigrationBefore = '104'; MigrationAfter = '105' }; Status = 'rolled_back'; Restarts = 2; Want = 'expected 105' },
            @{ Id = 'column'; Param = @{ ExtraColumns = 'personal_bots.not_a_real_column' }; Status = 'rolled_back'; Restarts = 2; Want = 'not_a_real_column' })) {
        if (-not (Should-Run "s5-$($case.Id)")) { continue }
        Write-Host "== s5 database expectation: $($case.Id)"
        $w = New-World "db-$($case.Id)"
        try {
            $pp = @{}
            foreach ($k in $case.Param.Keys) { $pp[$k] = $case.Param[$k] }
            if ($case.Id -eq 'before') { $prep = Invoke-Runner $w @('-Prepare') $pp } else { $prep = Prepare-World $w }
            if ($case.Id -eq 'before') {
                # Prepare with MigrationBefore 103 builds a 103 fixture and passes; the run then finds 104 in the backup
                Assert ($prep.Exit -eq 0) '[before] prepare passes with its own fixture'
            }
            Reset-Calls $w
            $r = Invoke-Runner $w @() $pp
            $res = Get-Result $w
            Write-Host "     exit=$($r.Exit) status=$($res.status) error=$($res.error)"
            Assert ($res.status -eq $case.Status) "[$($case.Id)] status $($case.Status)" "($($res.status))"
            Assert (([string]$res.error) -match [regex]::Escape($case.Want)) "[$($case.Id)] error names the cause" "(error: $($res.error))"
            Assert ((Calls-Of $w 'restart').Count -eq $case.Restarts) "[$($case.Id)] restarts = $($case.Restarts)" ((Calls-Of $w 'restart') -join ';')
        } finally { Remove-World $w }
    }
}
function Scenario-IdleAndBackupWindow {
    Write-Host '== s6 work resumes during the backup: refuse before restart'
    $w = New-World 'resume'
    try {
        $null = Prepare-World $w
        Reset-Calls $w
        Set-Flag $w 'idle-seq.txt' "idle`nidle`nidle`nbusy"
        $r = Invoke-Runner $w @()
        $res = Get-Result $w
        Assert ($r.Exit -eq 1 -and $res.status -eq 'failed') 'refused' "($($res.status): $($res.error))"
        Assert (([string]$res.error) -match 'Work resumed during backup') 'error names the cause' "($($res.error))"
        Assert ((Calls-Of $w 'restart').Count -eq 0) 'nothing restarted'
        Assert ((Backups-Count $w) -eq 1) 'the fresh backup exists (kept)'
        Assert (@(Calls-Of $w 'notify')[0] -match 'outcome=failed') 'failed notice'
    } finally { Remove-World $w }
}
function Scenario-IdleClassifierPin {
    Write-Host '== s7 idle classifier hash pin'
    $w = New-World 'pin'
    try {
        $null = Prepare-World $w
        Reset-Calls $w
        $keep = [Environment]::GetEnvironmentVariable('HBOTS_RELEASE_TEST_CLASSIFIER_SHA')
        # Invoke-Runner sets its own env; wrap the classifier file instead: edit it, run, restore
        $cls = Join-Path $stubs 'idle-stub.mjs'
        $orig = [System.IO.File]::ReadAllText($cls)
        # the runner is given the sha of the ORIGINAL file; a modified file must be refused before any restart
        $tmpCls = Join-Path $env:TEMP 'hbots-idle-pin.mjs'
        [System.IO.File]::WriteAllText($tmpCls, $orig)
        $sha = (Get-FileHash -LiteralPath $tmpCls -Algorithm SHA256).Hash
        [System.IO.File]::WriteAllText($tmpCls, $orig + "`n// changed after review`n")
        $envSet = @{ HBOTS_RELEASE_TEST_CLASSIFIER = $tmpCls; HBOTS_RELEASE_TEST_CLASSIFIER_SHA = $sha }
        # Invoke-Runner overrides these, so call the runner directly here
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-Release', $Rel, '-Rollback', $Rb, '-MainSha', $w.Main, '-Version', $Ver, '-NotifyThread', $Thread, '-MigrationBefore', '104', '-MigrationAfter', '104', '-RepoRoot', $w.Repo, '-AppSheet', $w.Sheet, '-AppHistory', $w.History)
        $saved = @{}
        $all = @{ USERPROFILE = $w.Root; HBOTS_RELEASE_TEST = '1'; HBOTS_TEST_FLAGS = $w.Flags; HBOTS_TEST_PORT = "$($w.Port)"; HBOTS_RELEASE_TEST_PORT = "$($w.Port)"; HBOTS_RELEASE_TEST_IDLE_SECONDS = '1'; HBOTS_RELEASE_TEST_STABLE_SECONDS = '6' } + $envSet
        foreach ($k in $all.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $all[$k]) }
        try {
            $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList (($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ') -NoNewWindow -Wait -PassThru
        } finally { foreach ($k in $all.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
        $res = Get-Result $w
        Assert ($p.ExitCode -eq 1 -and $res.status -eq 'failed') 'changed classifier refused' "($($res.status): $($res.error))"
        Assert (([string]$res.error) -match 'idle classifier changed') 'error names the classifier' "($($res.error))"
        Assert ((Calls-Of $w 'restart').Count -eq 0) 'nothing restarted'
        Remove-Item -LiteralPath $tmpCls -Force -ErrorAction SilentlyContinue
    } finally { Remove-World $w }
}
function Scenario-Concurrency {
    Write-Host '== s8 PERSONAL_TASKS_CONCURRENCY must be 5 at the shipped commit'
    $w = New-World 'conc' '4'
    try {
        $r = Invoke-Runner $w @('-Prepare')
        $res = Get-Result $w '-prepare'
        Assert ($r.Exit -eq 1) 'prepare refused a commit with concurrency 4' $r.Out
        Assert (([string]$res.error) -match 'PERSONAL_TASKS_CONCURRENCY') 'error names the rule' "($($res.error))"
        Assert (-not (Test-Path (Join-Path $w.Run "hbots-$Ver-seal.json"))) 'no seal written'
    } finally { Remove-World $w }
}
function Scenario-BackupRetention {
    Write-Host '== s10 backup retention: -BackupKeep prunes only the oldest timestamp backups, after the fresh one is written'
    foreach ($case in @(
        @{ Id = 'keep3'; Param = @{ BackupKeep = '3' }; WantTs = 3; WantPruned = 3 },
        @{ Id = 'default14'; Param = @{}; WantTs = 6; WantPruned = 0 },
        @{ Id = 'keepall'; Param = @{ BackupKeep = '2147483647' }; WantTs = 6; WantPruned = 0 }
    )) {
        $w = New-World ("ret-" + $case.Id)
        try {
            $null = Prepare-World $w
            $bdir = Join-Path $w.Home 'backups'
            foreach ($n in 1..5) {
                $d = Join-Path $bdir ('20200101-00000{0}' -f $n)
                New-Item -ItemType Directory -Force -Path $d | Out-Null
                Write-File (Join-Path $d 'backup.json') '{}'
            }
            Write-File (Join-Path (Join-Path $bdir 'pre-cfo-keepme') 'backup.json') '{}'
            Write-File (Join-Path $bdir 'stray-file.txt') 'x'
            $unfinished = Join-Path $bdir '20190101-000001'
            Write-File (Join-Path $unfinished 'backup.json.pending') '{'
            if ($case.Id -eq 'keep3') {
                # a dry run reports what the retention would remove and removes nothing
                $dr = Invoke-Runner $w @('-DryRun') $case.Param
                $dres = Get-Result $w '-dryrun'
                Assert ($dr.Exit -eq 0 -and @($dres.backupsWouldPrune).Count -eq 3) '[keep3] dry run lists the 3 backups it would prune' "(exit $($dr.Exit): $($dr.Out))"
                Assert ((@(Get-ChildItem -LiteralPath $bdir -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' })).Count -eq 6) '[keep3] dry run deleted nothing'
            }
            Reset-Calls $w
            $r = Invoke-Runner $w @() $case.Param
            $res = Get-Result $w
            Assert ($r.Exit -eq 0 -and $res.status -eq 'live_verified') "[$($case.Id)] release verified" "($($res.status): $($res.error))"
            $ts = @(Get-ChildItem -LiteralPath $bdir -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' -and (Test-Path (Join-Path $_.FullName 'backup.json')) } | Sort-Object Name)
            Assert ($ts.Count -eq $case.WantTs) "[$($case.Id)] timestamp backups after the run" "(have $($ts.Count): $(($ts | ForEach-Object Name) -join ','))"
            Assert (@($res.backupsPruned).Count -eq $case.WantPruned) "[$($case.Id)] result lists the pruned backups" "($(@($res.backupsPruned) -join ','))"
            Assert (Test-Path -LiteralPath $res.backupPath) "[$($case.Id)] the fresh backup is kept"
            Assert ((Test-Path (Join-Path $unfinished 'backup.json.pending')) -and -not (Test-Path (Join-Path $unfinished 'backup.json'))) "[$($case.Id)] unfinished manifest is kept for inspection and never counts as a verified backup"
            Assert ((Test-Path -LiteralPath (Join-Path $bdir 'pre-cfo-keepme')) -and (Test-Path -LiteralPath (Join-Path $bdir 'stray-file.txt'))) "[$($case.Id)] non-timestamp entries untouched"
            if ($case.Id -eq 'keep3') {
                Assert (-not (Test-Path -LiteralPath (Join-Path $bdir '20200101-000001')) -and (Test-Path -LiteralPath (Join-Path $bdir '20200101-000005'))) '[keep3] the oldest are gone, the newest old ones kept'
            }
        } finally { Remove-World $w }
    }
}
function Scenario-DryRun {
    Write-Host '== s9 dry run: guards only, no real log/result, no backup, restart or notice'
    $w = New-World 'dry'
    try {
        $null = Prepare-World $w
        Reset-Calls $w
        $r = Invoke-Runner $w @('-DryRun', '-VerifyLive', '-StableSeconds', '5') @{}
        Assert ($r.Exit -eq 0) 'dry run exit 0' $r.Out
        Assert ($r.Out -match 'DRY RUN OK') 'prints DRY RUN OK'
        Assert (-not (Test-Path (Join-Path $w.Run "restart-$Ver-result.json"))) 'real result file not written'
        Assert (-not (Test-Path (Join-Path $w.Home "logs\restart-$Ver.log"))) 'real log file not written'
        Assert ((Test-Path (Join-Path $w.Run "restart-$Ver-dryrun-result.json"))) 'dry-run result written'
        Assert ((Calls-Of $w 'restart').Count -eq 0 -and (Calls-Of $w 'notify').Count -eq 0) 'no restart, no notice'
        Assert ((Backups-Count $w) -eq 0) 'no production backup'
        Assert ((Current $w) -eq $Rb) 'current.txt untouched'
        # with the target live (the 1.66.30 situation) VerifyLive runs the checks read-only
        Write-File (Join-Path $w.Home 'releases\current.txt') $Rel
        $sj = Get-Content (Join-Path $w.Run 'server.json') -Raw | ConvertFrom-Json
        $sj.release = $Rel
        $sj | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $w.Run 'server.json') -Encoding ASCII
        Reset-Calls $w
        $r2 = Invoke-Runner $w @('-DryRun', '-VerifyLive', '-StableSeconds', '5') @{}
        $dr = Get-Result $w '-dryrun'
        Assert ($r2.Exit -eq 0 -and $dr.status -eq 'dryrun_ok') 'dry run + verify-live passes with the target live' "($($r2.Out))"
        Assert ($dr.sentUnauthenticatedStatus -eq 401 -and $dr.phoneRelayReconnected) 'verify-live ran checks A and B'
        Assert ((Calls-Of $w 'restart').Count -eq 0) 'still no restart'
    } finally { Remove-World $w }
}

function Scenario-DigestTamper {
    Write-Host '== s11 database changed after full validation: no activation'
    $w = New-World 'digest'
    try {
        $backup = Join-Path $w.Repo 'scripts\personal\backup.ps1'
        $extra = @'

if ($paths.StateDir -eq 'STATE_PLACEHOLDER') {
    $fd = [IO.File]::Open((Join-Path $target 'state.sqlite'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try { $fd.Position = 1000; $value = $fd.ReadByte(); $fd.Position = 1000; $fd.WriteByte($value -bxor 1) } finally { $fd.Dispose() }
}
'@
        Write-File $backup ([IO.File]::ReadAllText($backup) + $extra.Replace('STATE_PLACEHOLDER', (Join-Path $w.Home 'dev\userdata')))
        $null = Invoke-TestGit $w.Repo @('add', '-A')
        $null = Invoke-TestGit $w.Repo @('commit', '-q', '-m', 'inject post-validation disk change')
        $w.Main = (Invoke-TestGit $w.Repo @('rev-parse', 'HEAD') | Select-Object -First 1).ToString().Trim()
        $null = Prepare-World $w
        Reset-Calls $w
        $r = Invoke-Runner $w @()
        $res = Get-Result $w
        Assert ($r.Exit -eq 1 -and $res.status -eq 'failed') 'digest corruption refused before activation' $r.Out
        Assert (([string]$res.error) -match 'digest mismatch') 'error identifies the changed bytes' $res.error
        Assert ((Calls-Of $w 'restart').Count -eq 0) 'nothing restarted'
        Assert ((Current $w) -eq $Rb) 'current.txt stays on the baseline'
        Assert ((Backups-Count $w) -eq 1) 'failed proof leaves the fresh backup for inspection'
    } finally { Remove-World $w }
}

if (Should-Run 's1') { Scenario-Happy }
if ($Only.Count -eq 0 -or ($Only | Where-Object { $_ -like 's2*' })) { Scenario-Rollbacks }
if (Should-Run 's3') { Scenario-Refusals }
if (Should-Run 's4') { Scenario-ParamGuards }
if ($Only.Count -eq 0 -or ($Only | Where-Object { $_ -like 's5*' })) { Scenario-DbExpectations }
if (Should-Run 's6') { Scenario-IdleAndBackupWindow }
if (Should-Run 's7') { Scenario-IdleClassifierPin }
if (Should-Run 's8') { Scenario-Concurrency }
if (Should-Run 's9') { Scenario-DryRun }
if (Should-Run 's10') { Scenario-BackupRetention }
if (Should-Run 's11') { Scenario-DigestTamper }

Write-Host ''
Write-Host ("RESULT: {0} checks passed, {1} failed" -f $script:Passed, $script:Failures.Count)
foreach ($f in $script:Failures) { Write-Host "  FAILED: $f" }
exit $script:Failures.Count
