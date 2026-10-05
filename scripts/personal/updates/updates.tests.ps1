<#
.SYNOPSIS
Tests for the nightly update pipeline's decisions and its two dangerous
mechanics: reverting a run, and surviving the restart.

.DESCRIPTION
Pure functions are tested without side effects. Two tests touch the system,
both inside a throwaway folder under %TEMP% that they delete afterwards:
- the revert path runs real git in a scratch repository: a run's commits are
  undone with new revert commits (never a reset), and the tree ends identical
  to the base;
- the detached launch starts a process through WMI from a child process, kills
  that child's whole tree the way restart.ps1 kills the server's, and checks
  the detached process lives on and finishes.
Run it directly; it exits non-zero on any failure.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'updates-common.ps1')
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Assert-Equal {
    param([string]$What, $Expected, $Actual)
    $expectedText = ($Expected -join ',')
    $actualText = ($Actual -join ',')
    if ($expectedText -eq $actualText) {
        Write-Host "  ok   $What"
    } else {
        Write-Host "  FAIL $What"
        Write-Host "       expected: [$expectedText]"
        Write-Host "       actual:   [$actualText]"
        $script:failures++
    }
}

function Assert-Throws {
    param([string]$What, [scriptblock]$Block)
    try { & $Block; Write-Host "  FAIL $What (no error)"; $script:failures++ } catch { Write-Host "  ok   $What" }
}

$now = [datetime]'2026-09-25T03:30:00Z'
$alive = { param($id) $id -eq 111 }

Write-Host 'Lock'
Assert-Equal 'no lock is free' $true (Test-UpdatesLockStale -Lock $null -Now $now -IsAlive $alive)
$botStage = [pscustomobject]@{ runId = 'r1'; stage = 'bot'; pid = 0; updatedAt = '2026-09-25T03:05:00Z' }
Assert-Equal 'the bot stage (no owner process) holds while young' $false (Test-UpdatesLockStale -Lock $botStage -Now $now -IsAlive $alive)
Assert-Equal '...and goes stale after 5 h' $true (Test-UpdatesLockStale -Lock $botStage -Now ([datetime]'2026-09-25T08:06:00Z') -IsAlive $alive)
$pipelineAlive = [pscustomobject]@{ runId = 'r1'; stage = 'pipeline'; pid = 111; updatedAt = '2026-09-25T03:05:00Z' }
Assert-Equal 'a live pipeline holds it' $false (Test-UpdatesLockStale -Lock $pipelineAlive -Now $now -IsAlive $alive)
$pipelineDead = [pscustomobject]@{ runId = 'r1'; stage = 'pipeline'; pid = 222; updatedAt = '2026-09-25T03:29:00Z' }
Assert-Equal 'a dead pipeline frees it at once' $true (Test-UpdatesLockStale -Lock $pipelineDead -Now $now -IsAlive $alive)
$garbled = [pscustomobject]@{ runId = 'r1'; updatedAt = 'not a date' }
Assert-Equal 'an unreadable lock is free' $true (Test-UpdatesLockStale -Lock $garbled -Now $now -IsAlive $alive)

Write-Host 'Lock file round trip (in a temp home)'
$savedHome = $UpdatesHome
$savedLock = $UpdatesLockFile
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('pb-updates-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
    $UpdatesHome = $tempRoot
    $UpdatesLockFile = Join-Path $tempRoot 'lock.json'
    Enter-UpdatesLock -RunId 'run-a' -Mode 'Live'
    Assert-Equal 'the run holds the lock' 'run-a' (Read-UpdatesLock).runId
    Assert-Throws 'a second run is refused while the first holds it' { Enter-UpdatesLock -RunId 'run-b' -Mode 'Live' }
    Assert-Throws 'ship refuses a run that does not hold the lock' { Assert-UpdatesLockOwner -RunId 'run-b' }
    Write-UpdatesLock @{ stage = 'pipeline'; pid = 999999 }
    Enter-UpdatesLock -RunId 'run-b' -Mode 'Live'
    Assert-Equal 'a dead pipeline''s lock is taken over' 'run-b' (Read-UpdatesLock).runId
    Exit-UpdatesLock -RunId 'run-a'
    Assert-Equal 'only the owner releases it' $true (Test-Path -LiteralPath $UpdatesLockFile)
    Exit-UpdatesLock -RunId 'run-b'
    Assert-Equal 'the owner releases it' $false (Test-Path -LiteralPath $UpdatesLockFile)
} finally {
    $UpdatesHome = $savedHome
    $UpdatesLockFile = $savedLock
}

Write-Host 'Versions and rollback target'
Assert-Equal 'patch bump' '1.35.1' (Get-UpdatesNextPatchVersion '1.35.0')
Assert-Equal 'patch bump past 9' '1.35.10' (Get-UpdatesNextPatchVersion "1.35.9`n")
Assert-Throws 'refuses a non x.y.z version' { Get-UpdatesNextPatchVersion '1.35' }
Assert-Equal 'rolls back to what is running' 'aaa' (Select-UpdatesRollbackTarget -RunningRelease 'aaa' -PreflightRelease 'bbb' -NewRelease 'new')
Assert-Equal 'falls back to the preflight release when nothing runs' 'bbb' (Select-UpdatesRollbackTarget -RunningRelease '' -PreflightRelease 'bbb' -NewRelease 'new')
Assert-Equal 'never to the new release itself' 'bbb' (Select-UpdatesRollbackTarget -RunningRelease 'new' -PreflightRelease 'bbb' -NewRelease 'new')
Assert-Equal 'never to a dirty build' 'bbb' (Select-UpdatesRollbackTarget -RunningRelease 'aaa-dirty-20260925' -PreflightRelease 'bbb' -NewRelease 'new')
Assert-Equal 'no target at all is null' $null (Select-UpdatesRollbackTarget -RunningRelease '' -PreflightRelease '' -NewRelease 'new')
$versionTxt = ConvertFrom-UpdatesKeyValue "version=1.35.1`r`nrelease=abc123def456`r`nclient=index-x.js"
Assert-Equal 'reads version.txt' '1.35.1 abc123def456' ("$($versionTxt['version']) $($versionTxt['release'])")

Write-Host 'What the bot may not touch'
Assert-Equal 'forbidden paths' '.env,apps/server/.env.local,secrets/key,scripts/personal/app-version.txt' `
    (Get-UpdatesForbiddenPaths -ChangedPaths @('.env', 'apps/server/.env.local', 'secrets/key', 'scripts/personal/app-version.txt', 'apps/server/src/x.ts', 'docs/environment.md'))
Assert-Equal 'normal changes pass' 0 (Get-UpdatesForbiddenPaths -ChangedPaths @('apps/server/package.json', 'pnpm-lock.yaml')).Count

Write-Host 'What counts as unshipped code (the preflight tree comparison)'
Assert-Equal 'the trunk is personal-bots/main' 'personal-bots/main' $UpdatesBranch
Assert-Equal 'a HANDOFF notes commit is not code' 0 @(Get-UpdatesCodePaths -ChangedPaths @('HANDOFF-1630.md')).Count
Assert-Equal 'other top-level notes, docs/ and the release tooling are not code' 0 `
    @(Get-UpdatesCodePaths -ChangedPaths @('FEATURES.md', 'CLAUDE.md', 'README.md', 'docs/internals/x.md', 'docs/img/a.png', 'scripts/personal/updates/nightly.ps1', 'scripts/personal/README.md', 'scripts/personal/perf/budget.json', 'scripts\personal\upstream-sync.ps1')).Count
Assert-Equal 'server, web and package code is' 'apps/server/src/x.ts,apps/web/src/y.tsx,packages/shared/z.ts' `
    @(Get-UpdatesCodePaths -ChangedPaths @('HANDOFF-1.md', 'apps/server/src/x.ts', 'apps/web/src/y.tsx', 'packages/shared/z.ts'))
Assert-Equal 'the lockfile, root config and CI scripts are' 'pnpm-lock.yaml,package.json,scripts/cli.ts,.github/workflows/ci.yml' `
    @(Get-UpdatesCodePaths -ChangedPaths @('pnpm-lock.yaml', 'package.json', 'scripts/cli.ts', '.github/workflows/ci.yml'))
Assert-Equal 'app-version.txt is carried by a release, so it is code' 'scripts/personal/app-version.txt' @(Get-UpdatesCodePaths -ChangedPaths @('scripts/personal/app-version.txt'))
Assert-Equal 'a markdown file inside apps/ is code (it can be imported)' 'apps/server/src/prompt.md' @(Get-UpdatesCodePaths -ChangedPaths @('apps/server/src/prompt.md'))
Assert-Equal 'a look-alike folder is code' 'docsx/a.md,scripts/personalx/a.ps1' @(Get-UpdatesCodePaths -ChangedPaths @('docsx/a.md', 'scripts/personalx/a.ps1'))
Assert-Equal 'no changes, no code' 0 @(Get-UpdatesCodePaths -ChangedPaths @()).Count
Assert-Equal 'in sync' 'same' (Get-UpdatesSyncState -Ahead 0 -Behind 0)
Assert-Equal 'only behind is healed' 'behind' (Get-UpdatesSyncState -Ahead 0 -Behind 3)
Assert-Equal 'unpushed commits are refused' 'ahead' (Get-UpdatesSyncState -Ahead 2 -Behind 0)
Assert-Equal 'diverged is refused' 'diverged' (Get-UpdatesSyncState -Ahead 1 -Behind 1)

Write-Host 'What counts as a build in progress'
$psExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
Assert-Equal 'powershell -File build.ps1 is a build' $true (Test-UpdatesBuildProcess -Name 'powershell.exe' -CommandLine "$psExe -NoProfile -ExecutionPolicy Bypass -File C:\Claude\AI\_wt\x\scripts\personal\build.ps1 -NoActivate")
Assert-Equal 'quoted -File path too' $true (Test-UpdatesBuildProcess -Name 'powershell.exe' -CommandLine "$psExe -File ""C:\Claude\AI\personal-bots\scripts\personal\restart.ps1"" -Release abc")
Assert-Equal 'the upstream sync is' $true (Test-UpdatesBuildProcess -Name 'powershell.exe' -CommandLine "$psExe -NoProfile -File C:\Claude\AI\personal-bots-sync\scripts\personal\upstream-sync.ps1 -Mode Auto")
Assert-Equal 'the vp build chain is' $true (Test-UpdatesBuildProcess -Name 'node.exe' -CommandLine '"C:\Program Files\nodejs\node.exe" node_modules/.bin/../vite-plus/bin/vp run --filter t3 build')
Assert-Equal 'an agent shell that only names the script is not (30 Sep false positive)' $false (Test-UpdatesBuildProcess -Name 'bash.exe' -CommandLine '"C:\Program Files\Git\bin\bash.exe" -c "grep -n x scripts/personal/build.ps1; powershell -File C:\a\scripts\personal\build.ps1"')
Assert-Equal 'a powershell command that merely mentions it is not' $false (Test-UpdatesBuildProcess -Name 'powershell.exe' -CommandLine "$psExe -NoProfile -Command Get-Content scripts\personal\build.ps1")
Assert-Equal 'an unrelated process is not' $false (Test-UpdatesBuildProcess -Name 'node.exe' -CommandLine 'node apps/server/dist/bin.mjs serve')

Write-Host 'Only the run''s own commits'
$range = @('8b0c8b587a11111111111111111111111111111a', 'ff6be2c33c22222222222222222222222222222b', '1f3435bf2833333333333333333333333333333c')
Assert-Equal 'a commit no proposal recorded is foreign' '1f3435bf2833333333333333333333333333333c' (Get-UpdatesForeignCommits -RangeCommits $range -RecordedCommits @('8b0c8b587a', 'FF6BE2C33C'))
Assert-Equal 'all recorded: none foreign' 0 (Get-UpdatesForeignCommits -RangeCommits $range[0..1] -RecordedCommits @('8b0c8b5', 'ff6be2c33c22222222222222222222222222222b')).Count
Assert-Equal 'a too-short id matches nothing' 1 (Get-UpdatesForeignCommits -RangeCommits $range[0..0] -RecordedCommits @('8b0c')).Count

Write-Host 'Gate output'
$esc = [char]27
$vitest = "$esc[31m FAIL $esc[0m src/personal/a.test.ts > case one`n + ok`n FAIL  src/personal/b.test.ts > case two`n FAIL  src/personal/a.test.ts > case one"
Assert-Equal 'vitest FAIL lines, deduped, colours stripped' 'src/personal/a.test.ts > case one,src/personal/b.test.ts > case two' (Get-UpdatesVitestFailures -Output $vitest)
$gates = Get-UpdatesGateList -Root 'C:\x'
Assert-Equal 'the gate set' 'test-server,test-web,typecheck-contracts,typecheck-shared,typecheck-client-runtime,typecheck-server,typecheck-web,lint' ($gates | ForEach-Object { $_.Name })
Assert-Equal 'never a bare vp test run in apps\server' 'test,run,src/personal' ($gates | Where-Object { $_.Name -eq 'test-server' }).Args
# Regression (second dry run 2026-09-24): tsc exits 1 on an Effect warning alone.
$tscOut = "src/a.ts(1,2): suggestion TS377098: prefer x. effect(schemaNumber)`nsrc/personal/connections/service.test.ts(256,7): warning TS377033: chains provide. effect(multipleEffectProvide)"
Assert-Equal 'tsc warnings and suggestions are not errors' 0 (Get-UpdatesTscErrors -Output $tscOut).Count
Assert-Equal 'tsc errors are' 'src/b.ts(3,4): error TS2322: Type string is not number.' (Get-UpdatesTscErrors -Output ($tscOut + "`nsrc/b.ts(3,4): error TS2322: Type string is not number.`n"))
Assert-Equal 'the typecheck gates judge by error lines' 'tsc,tsc,tsc,tsc,tsc' ($gates | Where-Object { $_.Name -like 'typecheck-*' } | ForEach-Object { $_.Kind })
# Regression (dry run 2026-09-24): a relative tsc.cmd could not be started.
Assert-Equal 'every gate program is an absolute path' 0 @($gates | Where-Object { -not [System.IO.Path]::IsPathRooted($_.File) }).Count

Write-Host 'Gate runner (real processes)'
$gateDir = Join-Path $tempRoot 'gates'
New-Item -ItemType Directory -Force -Path $gateDir | Out-Null
# Regression (dry run 2026-09-24): the runner's own `$logFile` shadowed the
# caller's, so progress lines went into the gate logs. Use the caller's name.
$logFile = Join-Path $tempRoot 'caller.log'
$callerLog = { param([string]$Text) Add-Content -LiteralPath $logFile -Value $Text }
$fakeGates = @(
    @{ Name = 'green'; Dir = '.'; File = $env:ComSpec; Args = @('/c', 'exit', '0'); Kind = 'exit' },
    @{ Name = 'red'; Dir = '.'; File = $env:ComSpec; Args = @('/c', 'exit', '3'); Kind = 'exit' },
    @{ Name = 'missing'; Dir = '.'; File = (Join-Path $tempRoot 'no-such-program.exe'); Args = @(); Kind = 'exit' }
)
$gateRed = Invoke-UpdatesGates -Gates $fakeGates -Root $tempRoot -LogDir $gateDir -Log $callerLog
Assert-Equal 'red and unstartable gates are red, green is not' 'red,missing' (@($gateRed | ForEach-Object { ($_ -split ' ')[0] }))
Assert-Equal 'progress reaches the caller''s log' 'gate green ...,gate red ...,gate missing ...' (Get-Content -LiteralPath $logFile)

Write-Host 'The urgent marker matches the push service'
$ledgerSource = Get-Content -LiteralPath (Join-Path $PbRepoRoot 'apps\server\src\personal\claudeCodeReview\proposalLedger.ts') -Raw
Assert-Equal 'URGENT_REPORT_PREFIX' $true ($ledgerSource -match ('export const URGENT_REPORT_PREFIX = "' + [regex]::Escape($UpdatesUrgentPrefix) + '";'))

Write-Host 'Revert path (real git, scratch repository)'
$repoDir = Join-Path $tempRoot 'repo'
New-Item -ItemType Directory -Force -Path $repoDir | Out-Null
try {
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs @('init', '--quiet', '-b', 'main'))
    Set-Content -LiteralPath (Join-Path $repoDir 'a.txt') -Value 'base' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs @('add', '.'))
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'base')))
    $baseSha = Get-UpdatesGitText -Repo $repoDir -GitArgs @('rev-parse', 'HEAD')
    Set-Content -LiteralPath (Join-Path $repoDir 'a.txt') -Value 'P1 changed a' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-am', 'fix: P1')))
    Set-Content -LiteralPath (Join-Path $repoDir 'b.txt') -Value 'P3 added b' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs @('add', 'b.txt'))
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'feat: P3')))
    $runCommits = @(Get-UpdatesGitLines -Repo $repoDir -GitArgs @('rev-list', '--reverse', "$baseSha..HEAD"))
    $headBefore = Get-UpdatesGitText -Repo $repoDir -GitArgs @('rev-parse', 'HEAD')
    $created = Invoke-UpdatesRevert -Repo $repoDir -Commits $runCommits -Reason 'test'
    Assert-Equal 'one revert commit per run commit' 2 $created.Count
    $same = Invoke-UpdatesGit -Repo $repoDir -GitArgs @('diff', '--quiet', $baseSha, 'HEAD', '--') -AllowFail
    Assert-Equal 'the tree is identical to the base again' 0 $same.Code
    $isAncestor = Invoke-UpdatesGit -Repo $repoDir -GitArgs @('merge-base', '--is-ancestor', $headBefore, 'HEAD') -AllowFail
    Assert-Equal 'history kept: the old head is still an ancestor (no reset)' 0 $isAncestor.Code
    $subjects = @(Get-UpdatesGitLines -Repo $repoDir -GitArgs @('log', '--format=%s', '-2'))
    Assert-Equal 'newest first: P3 reverted before P1' 'Revert "fix: P1",Revert "feat: P3"' $subjects
    $author = Get-UpdatesGitText -Repo $repoDir -GitArgs @('log', '-1', '--format=%ae')
    Assert-Equal 'reverts are authored by the personal identity' 'harout_b5@live.com' $author

    # A revert that cannot apply is aborted, never forced.
    Set-Content -LiteralPath (Join-Path $repoDir 'c.txt') -Value 'one' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs @('add', 'c.txt'))
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'c one')))
    $cOne = Get-UpdatesGitText -Repo $repoDir -GitArgs @('rev-parse', 'HEAD')
    Set-Content -LiteralPath (Join-Path $repoDir 'c.txt') -Value 'two' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $repoDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-am', 'c two')))
    Assert-Throws 'a conflicting revert throws' { Invoke-UpdatesRevert -Repo $repoDir -Commits @($cOne) -Reason 'test' }
    $status = @(Get-UpdatesGitLines -Repo $repoDir -GitArgs @('status', '--porcelain'))
    Assert-Equal '...and leaves no revert in progress' 0 $status.Count
} catch {
    Write-Host "  FAIL revert path threw: $($_.Exception.Message)"
    $script:failures++
}

Write-Host 'Release, then HANDOFF on top (real git, scratch repository)'
$relDir = Join-Path $tempRoot 'release-repo'
New-Item -ItemType Directory -Force -Path (Join-Path $relDir 'apps\server\src') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $relDir 'scripts\personal\updates') | Out-Null
try {
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('init', '--quiet', '-b', 'personal-bots/main'))
    Set-Content -LiteralPath (Join-Path $relDir 'apps\server\src\a.ts') -Value 'export const a = 1;' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $relDir 'scripts\personal\app-version.txt') -Value '1.63.0' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $relDir 'scripts\personal\updates\nightly.ps1') -Value '# one' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('add', '.'))
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'hbots 1.63.0')))
    $liveSha = Get-UpdatesGitText -Repo $relDir -GitArgs @('rev-parse', '--short=12', 'HEAD')
    $diffNames = { @(Get-UpdatesGitLines -Repo $relDir -GitArgs @('-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', $liveSha, 'HEAD', '--')) }
    Set-Content -LiteralPath (Join-Path $relDir 'HANDOFF-1630.md') -Value 'notes' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('add', '.'))
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'HANDOFF-1630')))
    $wholeTree = Invoke-UpdatesGit -Repo $relDir -GitArgs @('diff', '--quiet', $liveSha, 'HEAD', '--') -AllowFail
    Assert-Equal 'the old whole-tree test refused this (the 26 Sep to 4 Oct bug)' 1 $wholeTree.Code
    Assert-Equal 'HANDOFF on top of the release: no code differs' 0 @(Get-UpdatesCodePaths -ChangedPaths (& $diffNames)).Count
    Set-Content -LiteralPath (Join-Path $relDir 'scripts\personal\updates\nightly.ps1') -Value '# two' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('add', '.'))
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'fix tooling')))
    Assert-Equal 'a tooling-only commit on top is not code either' 0 @(Get-UpdatesCodePaths -ChangedPaths (& $diffNames)).Count
    Set-Content -LiteralPath (Join-Path $relDir 'apps\server\src\a.ts') -Value 'export const a = 2;' -Encoding ASCII
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('add', '.'))
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'staged, not live')))
    Assert-Equal 'a staged server change on top is refused, and named' 'apps/server/src/a.ts' @(Get-UpdatesCodePaths -ChangedPaths (& $diffNames))
    # A move out of a code path lists both sides (--no-renames), so code cannot hide as a note.
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs @('mv', 'apps/server/src/a.ts', 'HANDOFF-moved.md'))
    [void](Invoke-UpdatesGit -Repo $relDir -GitArgs ($UpdatesGitIdentity + @('commit', '--quiet', '-m', 'move code into a note')))
    Assert-Equal 'code moved into a .md file still shows the code path' 'apps/server/src/a.ts' @(Get-UpdatesCodePaths -ChangedPaths (& $diffNames))
    $missing = Invoke-UpdatesGit -Repo $relDir -GitArgs @('rev-parse', '--verify', '--quiet', 'ffffffffffff^{commit}') -AllowFail
    Assert-Equal 'an unknown live release is detected' $true ($missing.Code -ne 0)
} catch {
    Write-Host "  FAIL release/HANDOFF scenario threw: $($_.Exception.Message)"
    $script:failures++
}

Write-Host 'node_modules against the lockfile'
$depsDir = Join-Path $tempRoot 'deps'
New-Item -ItemType Directory -Force -Path (Join-Path $depsDir 'node_modules\.pnpm') | Out-Null
Set-Content -LiteralPath (Join-Path $depsDir 'pnpm-lock.yaml') -Value 'lockfileVersion: 9' -Encoding ASCII
Assert-Equal 'no pnpm copy of the lockfile, no marker: stale' $false (Test-UpdatesDependenciesCurrent -Root $depsDir)
Set-Content -LiteralPath (Join-Path $depsDir 'node_modules\.pnpm\lock.yaml') -Value 'lockfileVersion: 8' -Encoding ASCII
Assert-Equal 'pnpm installed from an older lockfile: stale (the main checkout on 5 Oct)' $false (Test-UpdatesDependenciesCurrent -Root $depsDir)
Set-Content -LiteralPath (Join-Path $depsDir 'node_modules\.pnpm\lock.yaml') -Value 'lockfileVersion: 9' -Encoding ASCII
Assert-Equal 'pnpm installed from this lockfile: current' $true (Test-UpdatesDependenciesCurrent -Root $depsDir)
Set-Content -LiteralPath (Join-Path $depsDir 'pnpm-lock.yaml') -Value 'lockfileVersion: 10' -Encoding ASCII
Assert-Equal 'lockfile moved on: stale again' $false (Test-UpdatesDependenciesCurrent -Root $depsDir)
Set-UpdatesDependenciesMarker -Root $depsDir
Assert-Equal 'our own install marker makes it current' $true (Test-UpdatesDependenciesCurrent -Root $depsDir)
Set-Content -LiteralPath (Join-Path $depsDir 'pnpm-lock.yaml') -Value 'lockfileVersion: 11' -Encoding ASCII
Assert-Equal 'the marker goes stale with the lockfile' $false (Test-UpdatesDependenciesCurrent -Root $depsDir)
Remove-Item -LiteralPath (Join-Path $depsDir 'node_modules') -Recurse -Force
Assert-Equal 'no node_modules at all: stale' $false (Test-UpdatesDependenciesCurrent -Root $depsDir)
Assert-Equal 'a repo with no lockfile has nothing to install' $true (Test-UpdatesDependenciesCurrent -Root (Join-Path $tempRoot 'gates'))

Write-Host 'Detached launch survives the caller''s process tree being killed'
try {
    $marker = Join-Path $tempRoot 'detached-finished.txt'
    $pidFile = Join-Path $tempRoot 'detached.pid'
    $child = Join-Path $tempRoot 'child.ps1'
    $payload = Join-Path $tempRoot 'payload.ps1'
    Set-Content -LiteralPath $payload -Value "Start-Sleep -Seconds 12; Set-Content -LiteralPath '$marker' -Value done" -Encoding ASCII
    Set-Content -LiteralPath $child -Encoding ASCII -Value @"
. '$(Join-Path $PSScriptRoot 'updates-common.ps1')'
`$id = Start-UpdatesDetached -ScriptPath '$payload' -WorkingDirectory '$tempRoot'
Set-Content -LiteralPath '$pidFile' -Value `$id
Start-Sleep -Seconds 60
"@
    $caller = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $child) -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
    $detachedPid = [int](Get-Content -LiteralPath $pidFile)
    $parent = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $detachedPid").ParentProcessId
    Assert-Equal 'the detached process is not the caller''s child' $true ($parent -ne $caller.Id)
    # What restart.ps1 does to the server tree that contains the bot.
    [void](Stop-PbProcessTree -ProcessId $caller.Id)
    Assert-Equal 'the caller''s tree is gone' $false (Test-UpdatesPidAlive $caller.Id)
    Assert-Equal 'the detached process is still alive' $true (Test-UpdatesPidAlive $detachedPid)
    for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $marker); $i++) { Start-Sleep -Milliseconds 500 }
    Assert-Equal 'and it finishes its work' $true (Test-Path -LiteralPath $marker)
} catch {
    Write-Host "  FAIL detached launch threw: $($_.Exception.Message)"
    $script:failures++
}

# Only our own temp folder, never followed through a junction (there are none in it).
& $env:ComSpec /d /s /c ('rmdir /s /q "' + $tempRoot + '"') 2>&1 | Out-Null

if ($script:failures -gt 0) {
    Write-Host "$($script:failures) failure(s)."
    exit 1
}
Write-Host 'All passed.'
exit 0
