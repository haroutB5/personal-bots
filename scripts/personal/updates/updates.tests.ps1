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
# 5 Oct: `main` carries 14 lint errors in 7 files nobody touches, so a whole-repo lint gate reverted every run.
$lintOut = "apps/server/src/provider/processTree.ts:23:1: error t3code(namespace-node-imports): Import node:child_process as a namespace.`napps\web\src\x.tsx:9:3: warning react(refs): Cannot access refs.`n$esc[31mscripts/personal/adblock/crawl.mjs:4:1: error$esc[0m t3code(namespace-node-imports): Import.`nsomething else"
Assert-Equal 'lint: files with an ERROR (not a warning), colours stripped, forward slashes' 'apps/server/src/provider/processTree.ts,scripts/personal/adblock/crawl.mjs' (Get-UpdatesLintErrorFiles -Output $lintOut)
Assert-Equal 'lint: a warning-only output has none' 0 @(Get-UpdatesLintErrorFiles -Output "apps/web/src/x.tsx:9:3: warning react(refs): x").Count
Assert-Equal 'the lint gate judges by changed files' 'lint' (($gates | Where-Object { $_.Name -eq 'lint' }).Kind)

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

# The lint gate: a lint program that always exits 1 with errors in two files.
$lintScript = Join-Path $gateDir 'fake-lint.cmd'
Set-Content -LiteralPath $lintScript -Encoding ASCII -Value @(
    '@echo off',
    'echo apps/server/src/provider/processTree.ts:23:1: error t3code(namespace-node-imports): x',
    'echo apps/web/src/features/personal/BotRow.tsx:9:3: error t3code(some-rule): y',
    'echo apps/web/src/other.tsx:1:1: warning react(refs): z',
    'exit /b 1')
$lintGate = @(@{ Name = 'lint'; Dir = '.'; File = $lintScript; Args = @(); Kind = 'lint' })
$lintRedElsewhere = Invoke-UpdatesGates -Gates $lintGate -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @('apps/server/src/other.ts', 'README.md')
Assert-Equal 'lint: errors only in files the run did not change are not red' 0 $lintRedElsewhere.Count
$lintRedMine = Invoke-UpdatesGates -Gates $lintGate -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @('apps/web/src/features/personal/BotRow.tsx')
Assert-Equal 'lint: an error in a file the run changed is red, and names it' $true (($lintRedMine.Count -eq 1) -and ($lintRedMine[0] -like 'lint: lint error(s) in a file this run changed: apps/web/src/features/personal/BotRow.tsx*'))
$lintCrash = @(@{ Name = 'lint'; Dir = '.'; File = $env:ComSpec; Args = @('/c', 'exit', '1'); Kind = 'lint' })
Assert-Equal 'lint: exit 1 with nothing listed (a crash) is red' 1 (Invoke-UpdatesGates -Gates $lintCrash -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @()).Count

# 6 Oct: the 04:00 run was reverted ("lint exited 1 with no lint errors listed") because `vp lint` printed
# its default layout (a header line, then ",-[file:line:col]") that the parser could not read.
# The fixture is the real gate-lint.log of that run, trimmed to its 12 error blocks, a dozen warning
# blocks and the tail: 6 files with errors, "Found 858 warnings and 12 errors."
$realLint = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixtures\lint-default-layout-6oct.log') -Raw
$expectedErrorFiles = 'apps/server/src/provider/Layers/CodexSessionRuntime.test.ts,apps/server/src/provider/processTree.test.ts,apps/server/src/provider/processTree.ts,scripts/personal/adblock/build-list.mjs,scripts/personal/adblock/crawl.mjs,scripts/personal/adblock/extract-domains.mjs'
Assert-Equal 'lint (real default layout): the 6 files with errors, no warning-only files' $expectedErrorFiles (Get-UpdatesLintErrorFiles -Output $realLint)
$realSummary = Get-UpdatesLintSummary -Output $realLint
Assert-Equal 'lint (real default layout): the summary line' '858 warnings, 12 errors' ("$($realSummary.Warnings) warnings, $($realSummary.Errors) errors")
Assert-Equal 'lint: no summary line (a crash) reads as none' $true ($null -eq (Get-UpdatesLintSummary -Output "something broke`nTimed out"))
Assert-Equal 'lint: a warning block alone lists no file' 0 @(Get-UpdatesLintErrorFiles -Output "  ! eslint(no-unused-vars): Catch parameter 'e' is never used.`n     ,-[scripts/personal/adblock/crawl.mjs:105:12]`n 105 |   } catch (e) {}`n     ``----`n").Count
Assert-Equal 'lint: a warning after an error does not borrow its location' 'a.ts' (Get-UpdatesLintErrorFiles -Output "  x r(a): m`n   ,-[a.ts:1:1]`n 1 | x`n   ``----`n`n  ! r(b): w`n   ,-[b.ts:2:2]`n 2 | y`n   ``----`n")
Assert-Equal 'lint: Windows separators become forward slashes in the default layout' 'apps/web/src/x.tsx' (Get-UpdatesLintErrorFiles -Output "  x r(a): m`n   ,-[apps\web\src\x.tsx:3:4]`n")
$realLintPath = 'C:\Users\Ht\.personal-bots\claude-code-updates\runs\20261006-0400\gate-lint.log'
if (Test-Path -LiteralPath $realLintPath) {
    Assert-Equal 'lint: the whole real 6 Oct log (15 000 lines) gives the same 6 files' $expectedErrorFiles (Get-UpdatesLintErrorFiles -Output (Get-Content -LiteralPath $realLintPath -Raw))
}
$fixtureLint = Join-Path $gateDir 'fake-lint-real.cmd'
Set-Content -LiteralPath $fixtureLint -Encoding ASCII -Value @('@echo off', ('type "{0}"' -f (Join-Path $PSScriptRoot 'fixtures\lint-default-layout-6oct.log')), 'exit /b 1')
$realGate = @(@{ Name = 'lint'; Dir = '.'; File = $fixtureLint; Args = @(); Kind = 'lint' })
Assert-Equal 'lint (real log, exit 1): errors only in files the run did not change are not red' 0 (Invoke-UpdatesGates -Gates $realGate -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @('apps/server/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')).Count
$realRed = Invoke-UpdatesGates -Gates $realGate -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @('scripts/personal/adblock/crawl.mjs', 'README.md')
Assert-Equal 'lint (real log, exit 1): an error in a changed file is red and names it' $true (($realRed.Count -eq 1) -and ($realRed[0] -like 'lint: lint error(s) in a file this run changed: scripts/personal/adblock/crawl.mjs*'))
$noErrorsGate = Join-Path $gateDir 'fake-lint-zero.cmd'
Set-Content -LiteralPath $noErrorsGate -Encoding ASCII -Value @('@echo off', 'echo Found 12 warnings and 0 errors.', 'exit /b 1')
Assert-Equal 'lint: exit 1 with a summary of 0 errors is not a crash' 0 (Invoke-UpdatesGates -Gates @(@{ Name = 'lint'; Dir = '.'; File = $noErrorsGate; Args = @(); Kind = 'lint' }) -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @()).Count
$unreadableGate = Join-Path $gateDir 'fake-lint-unreadable.cmd'
Set-Content -LiteralPath $unreadableGate -Encoding ASCII -Value @('@echo off', 'echo something in a layout nobody wrote a parser for', 'echo Found 3 warnings and 2 errors.', 'exit /b 1')
$unreadableRed = Invoke-UpdatesGates -Gates @(@{ Name = 'lint'; Dir = '.'; File = $unreadableGate; Args = @(); Kind = 'lint' }) -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @()
Assert-Equal 'lint: errors counted but none tied to a file is red (never pass on a guess)' $true (($unreadableRed.Count -eq 1) -and ($unreadableRed[0] -like 'lint: lint counted 2 error(s) but none could be tied to a file*'))
$partialGate = Join-Path $gateDir 'fake-lint-partial.cmd'
Set-Content -LiteralPath $partialGate -Encoding ASCII -Value @('@echo off', 'echo   x r(a): m', 'echo    ,-[unchanged/old.ts:1:1]', 'exit /b 1')
$partialRed = Invoke-UpdatesGates -Gates @(@{ Name = 'lint'; Dir = '.'; File = $partialGate; Args = @(); Kind = 'lint' }) -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @('apps/server/package.json')
Assert-Equal 'lint: an error printed, then a crash before the summary, is red even if the file is unchanged' $true (($partialRed.Count -eq 1) -and ($partialRed[0] -like 'lint exited 1 without a lint summary*'))
$cleanGate = Join-Path $gateDir 'fake-lint-clean.cmd'
Set-Content -LiteralPath $cleanGate -Encoding ASCII -Value @('@echo off', 'echo Found 858 warnings and 0 errors.', 'exit /b 0')
Assert-Equal 'lint: exit 0 with 0 errors is green' 0 (Invoke-UpdatesGates -Gates @(@{ Name = 'lint'; Dir = '.'; File = $cleanGate; Args = @(); Kind = 'lint' }) -Root $tempRoot -LogDir $gateDir -Log $callerLog -ChangedPaths @()).Count

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

Write-Host 'Waiting for every bot and task to be idle before a restart (a real SQLite file, the real node check)'
$idleDb = Join-Path $tempRoot 'idle-state.sqlite'
$idleNode = Resolve-NodeExe
$setDb = {
    param([string[]]$Statements)
    $env:PB_TEST_DB = $idleDb
    $env:PB_TEST_SQL = ($Statements -join ';')
    $r = Invoke-UpdatesProc -FilePath $idleNode -ArgList @('--disable-warning=ExperimentalWarning', '-e', 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.PB_TEST_DB);d.exec(process.env.PB_TEST_SQL);d.close()') -WorkingDirectory $tempRoot -TimeoutSeconds 60
    if ($r.Code -ne 0) { throw "test db write failed: $($r.Err)" }
}
& $setDb @(
    'create table projection_threads (thread_id text, deleted_at text)',
    'create table projection_thread_sessions (thread_id text, status text)',
    'create table personal_tasks (task_id text, bot_id text, status text)',
    "insert into projection_threads values ('live', null), ('gone', '2026-10-01')"
)
Assert-Equal 'nothing running: idle' 'idle' (Get-PbBusyState -StateDb $idleDb)
& $setDb @("insert into projection_thread_sessions values ('gone', 'running')")
Assert-Equal 'a running session of a deleted chat does not count' 'idle' (Get-PbBusyState -StateDb $idleDb)
& $setDb @("insert into projection_thread_sessions values ('live', 'ready')")
Assert-Equal 'a ready session does not count' 'idle' (Get-PbBusyState -StateDb $idleDb)
& $setDb @("update projection_thread_sessions set status = 'running' where thread_id = 'live'")
Assert-Equal 'any bot''s running chat session is busy' 'busy sessions=1 tasks=0' (Get-PbBusyState -StateDb $idleDb)
& $setDb @("update projection_thread_sessions set status = 'ready'", "insert into personal_tasks values ('t1', 'personal-frontend', 'running')")
Assert-Equal 'another bot''s running task (not the Updates bot) is busy' 'busy sessions=0 tasks=1' (Get-PbBusyState -StateDb $idleDb)
foreach ($status in @('queued', 'waiting_for_agent', 'waiting_for_user', 'waiting_for_browser', 'rate_limited')) {
    & $setDb @("update personal_tasks set status = '$status'")
    Assert-Equal "a $status task is busy (same set as the idle waiter)" 'busy sessions=0 tasks=1' (Get-PbBusyState -StateDb $idleDb)
}
& $setDb @("update personal_tasks set status = 'completed'")
Assert-Equal 'a finished task is not' 'idle' (Get-PbBusyState -StateDb $idleDb)
Assert-Equal 'an unreadable database counts as busy, never idle' $true ((Get-PbBusyState -StateDb (Join-Path $tempRoot 'no-such.sqlite')) -like 'unreadable:*')

& $setDb @("update personal_tasks set status = 'running'")
$waitLog = New-Object System.Collections.Generic.List[string]
$waitSw = [System.Diagnostics.Stopwatch]::StartNew()
$timedOut = Wait-PbAllIdle -TimeoutMinutes 0.05 -PollSeconds 1 -StateDb $idleDb -Log { param($t) $waitLog.Add($t) | Out-Null }
Assert-Equal 'still busy at the timeout: not idle' $false $timedOut
Assert-Equal 'the busy state was logged once' 'idle check: busy sessions=0 tasks=1' $waitLog.ToArray()
Assert-Equal 'it really waited for the timeout (3 s)' $true ($waitSw.Elapsed.TotalSeconds -ge 2.5)

# Busy, then the other bot's task ends (callback on the first busy look), then a task
# starts again after the first idle look: the streak restarts. Idle only after 3 in a row.
$phase = [pscustomobject]@{ n = 0 }
$seq = New-Object System.Collections.Generic.List[string]
$onLog = {
    param($t)
    $seq.Add($t) | Out-Null
    $phase.n++
    if ($phase.n -eq 1) { & $setDb @("update personal_tasks set status = 'completed'") }
    elseif ($phase.n -eq 2) { & $setDb @("update personal_tasks set status = 'running'") }
    elseif ($phase.n -eq 3) { & $setDb @("update personal_tasks set status = 'completed'") }
}
$waitSw.Restart()
$became = Wait-PbAllIdle -TimeoutMinutes 2 -PollSeconds 1 -StateDb $idleDb -Log $onLog
Assert-Equal 'waits while the other bot works, restarts the count when work resumes, then proceeds' $true $became
Assert-Equal 'the states it saw, in order' 'idle check: busy sessions=0 tasks=1|idle check: idle|idle check: busy sessions=0 tasks=1|idle check: idle' ($seq -join '|')
Assert-Equal 'three idle looks after the last busy one (about 2 s apart at 1 s polls)' $true ($waitSw.Elapsed.TotalSeconds -ge 4)

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

# 6 Oct: a failed build used to leave its half-built release folder behind for good.
Write-Host 'Failed-build release cleanup'
$cleanRoot = Join-Path $tempRoot 'failed-build'
$cleanReleases = Join-Path $cleanRoot 'releases'
New-Item -ItemType Directory -Path $cleanReleases -Force | Out-Null
$cleanPaths = [pscustomobject]@{
    ReleasesDir = $cleanReleases
    CurrentFile = (Join-Path $cleanReleases 'current.txt')
    StateFile   = (Join-Path $cleanRoot 'server-state.json')
}
Set-Content -LiteralPath $cleanPaths.CurrentFile -Value 'aaaaaaaaaaaa' -Encoding ASCII
foreach ($name in @('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc')) {
    New-Item -ItemType Directory -Path (Join-Path $cleanReleases "$name\dist") -Force | Out-Null
}
$cleanLink = Join-Path $cleanRoot 'checkout-node-modules'
New-Item -ItemType Directory -Path $cleanLink -Force | Out-Null
Set-Content -LiteralPath (Join-Path $cleanLink 'keep.txt') -Value 'x' -Encoding ASCII
& $env:ComSpec /d /s /c ('mklink /J "' + (Join-Path $cleanReleases 'bbbbbbbbbbbb\node_modules') + '" "' + $cleanLink + '"') 2>&1 | Out-Null
Assert-Equal 'the active release is never removed' $false (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release 'aaaaaaaaaaaa')
Assert-Equal '...and its folder is still there' $true (Test-Path -LiteralPath (Join-Path $cleanReleases 'aaaaaaaaaaaa'))
Assert-Equal 'an empty name removes nothing' $false (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release '')
Assert-Equal 'a name with path parts removes nothing' $false (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release '..aaaaaaaaaaa')
Assert-Equal 'a missing folder is not an error' $false (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release 'dddddddddddd')
Assert-Equal 'the half-built release (with a node_modules junction) is removed' $true (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release 'bbbbbbbbbbbb')
Assert-Equal '...its folder is gone' $false (Test-Path -LiteralPath (Join-Path $cleanReleases 'bbbbbbbbbbbb'))
Assert-Equal '...the junction target is untouched' $true (Test-Path -LiteralPath (Join-Path $cleanLink 'keep.txt'))
Set-Content -LiteralPath $cleanPaths.StateFile -Value '{"release":"cccccccccccc"}' -Encoding ASCII
Assert-Equal 'the release the server runs is never removed' $false (Remove-UpdatesFailedBuildRelease -Paths $cleanPaths -Release 'cccccccccccc')
Assert-Equal '...and its folder is still there' $true (Test-Path -LiteralPath (Join-Path $cleanReleases 'cccccccccccc'))

# 6 Oct: build.ps1 crashed on a checkout with no upstream remote (empty merge-base output is $null in PowerShell 5.1).
Write-Host 'Upstream base'
$upRepo = Join-Path $tempRoot 'no-upstream'
New-Item -ItemType Directory -Path $upRepo -Force | Out-Null
[void](Invoke-UpdatesGit -Repo $upRepo -GitArgs @('init', '-q'))
[void](Invoke-UpdatesGit -Repo $upRepo -GitArgs ($UpdatesGitIdentity + @('commit', '-q', '--allow-empty', '-m', 'first')))
Assert-Equal 'a checkout with no upstream remote gives an empty base, not a crash' '' (Get-PbUpstreamBase -RepoRoot $upRepo)
[void](Invoke-UpdatesGit -Repo $upRepo -GitArgs @('update-ref', 'refs/remotes/upstream/main', 'HEAD'))
$upHead = Get-UpdatesGitText -Repo $upRepo -GitArgs @('rev-parse', 'HEAD')
Assert-Equal 'with an upstream/main it is the first 12 characters of the merge-base' $upHead.Substring(0, 12) (Get-PbUpstreamBase -RepoRoot $upRepo)

# Only our own temp folder, never followed through a junction (there are none in it).
& $env:ComSpec /d /s /c ('rmdir /s /q "' + $tempRoot + '"') 2>&1 | Out-Null

if ($script:failures -gt 0) {
    Write-Host "$($script:failures) failure(s)."
    exit 1
}
Write-Host 'All passed.'
exit 0
