<#
.SYNOPSIS
Runs the fork gate and the phone e2e for a staged hbots release and writes the evidence: commands, exit codes, test
counts, e2e journeys, the commit they ran on and whether the tree was clean.

.DESCRIPTION
Run it from the builder's worktree AFTER `build.ps1 -CopyExternals` staged the release and BEFORE the HANDOFF notes are
finished (it needs a clean tree, so commit the code first). It does three things:

  1. Runs each gate (default: server-tests, server-tsc, web-tests, web-tsc, ps-tests, e2e), reads its exit code and
     counts the tests it ran, and records the git commit (HEAD at the start and at the end) and whether tracked files
     were modified. The e2e gate is e2e-smoke.ps1 against the staged release folder.
  2. Writes the machine-readable copy next to the staged release: <ReleasesDir>\<release>\gate-evidence.json (full gate
     logs go to <release>\gate-evidence-logs\). It also records the SHA-256 of the staged dist\bin.mjs, so the evidence
     is tied to the artifact that was tested and not only to the commit.
  3. Writes a "Gate evidence" section into docs\releases\HANDOFF-<ver>.md between two marker comments (replaces it on a
     rerun). A missing notes file is created with a PROOF_PLACEHOLDER line, so the release stays refused until the real
     notes are written.

Then commit the notes (docs\releases only) and push. check-gate-evidence.ps1 (run by the release waiter, never on a
rollback) refuses a release when this evidence is missing, failed, or recorded for another commit than the release, or
when code changed after the gates ran.

Exit code: 0 every gate that ran passed and the evidence is complete; 1 a gate failed or the tree was not clean (the
evidence is still written, so the failure is on record, and check-gate-evidence.ps1 will refuse it); 2 bad arguments or
setup (nothing written).

.PARAMETER Version
x.y.z. Must equal the version in the staged release's VERSION file.

.PARAMETER Release
sha12 of the staged release under ~\.personal-bots\releases, or the folder itself.

.PARAMETER Gates
Comma-separated gate ids to run. Default: all. With -Merge the other gates keep the result of an earlier run on the
same commit (rerun one failed gate without rerunning the rest).

.PARAMETER RepoRoot
The worktree the gates run in (default: the repo this script sits in).

.PARAMETER Merge
Keep earlier results (same commit, clean tree) for gates that are not rerun.

.PARAMETER ReleasesDir
Test hook: releases folder (default ~\.personal-bots\releases).

.PARAMETER GatesJson
Test hook: a JSON file replacing the default gate definitions ([{id, kind, cwd, title, commands:[...]}]).

.PARAMETER SkipNotes
Do not touch docs\releases (tests).

.PARAMETER Json
Print one JSON line with the summary at the end.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.ps1 -Version 1.66.2 -Release <sha12>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.ps1 -Version 1.66.2 -Release <sha12> -Gates e2e -Merge
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Release,
    [string[]]$Gates,
    [string]$RepoRoot,
    [switch]$Merge,
    [string]$ReleasesDir,
    [string]$GatesJson,
    [switch]$SkipNotes,
    [string]$Node,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Stop-Evidence([string]$Message) {
    Write-Host "FAIL: $Message"
    exit 2
}

if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { Stop-Evidence "-Version must look like 1.66.2 (got '$Version')." }
$notesName = "HANDOFF-$($Matches[1])$($Matches[2])$($Matches[3]).md"
if (-not $RepoRoot) { $RepoRoot = $PbRepoRoot }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) { Stop-Evidence "$RepoRoot is not a git checkout." }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $ReleasesDir) { $ReleasesDir = (Get-PbPaths -Root dev).ReleasesDir }

$releaseDir = $null
if (Test-Path -LiteralPath (Join-Path $Release 'VERSION') -PathType Leaf) {
    $releaseDir = (Resolve-Path -LiteralPath $Release).Path
} elseif ($Release -match '^[0-9a-f]{12}(-dirty-\d+)?$') {
    $releaseDir = Join-Path $ReleasesDir $Release
}
if (-not $releaseDir -or -not (Test-Path -LiteralPath (Join-Path $releaseDir 'VERSION') -PathType Leaf)) {
    Stop-Evidence "Release '$Release' is not a staged release (no VERSION file). Stage it first: build.ps1 -CopyExternals."
}
$releaseName = Split-Path -Leaf $releaseDir
$versionLines = [System.IO.File]::ReadAllLines((Join-Path $releaseDir 'VERSION'))
function Get-VersionField([string]$Key) {
    foreach ($line in $versionLines) { if ($line -match ('^' + [regex]::Escape($Key) + '=(.*)$')) { return $Matches[1].Trim() } }
    return ''
}
$staged = [ordered]@{
    version = Get-VersionField 'version'; release = Get-VersionField 'release'; sha = Get-VersionField 'sha'
    dirty = (Get-VersionField 'dirty'); externals = Get-VersionField 'externals'
}
if ($staged.version -ne $Version) { Stop-Evidence "The staged release says version '$($staged.version)', not $Version." }
$binPath = Join-Path $releaseDir 'dist\bin.mjs'
if (-not (Test-Path -LiteralPath $binPath -PathType Leaf)) { Stop-Evidence "The staged release has no dist\bin.mjs ($binPath)." }
$binSha256 = (Get-FileHash -LiteralPath $binPath -Algorithm SHA256).Hash.ToLowerInvariant()

function Invoke-Git([string[]]$GitArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& git -C $RepoRoot @GitArgs 2>$null)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ Code = $code; Lines = @($out | ForEach-Object { "$_" }) }
}
function Get-TreeState {
    $head = Invoke-Git @('rev-parse', 'HEAD')
    $status = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
    return [pscustomobject]@{
        Head = if ($head.Code -eq 0 -and $head.Lines.Count -gt 0) { $head.Lines[0].Trim() } else { '' }
        Dirty = @($status.Lines | Where-Object { $_.Trim() })
    }
}

$start = Get-TreeState
if ($start.Head -notmatch '^[0-9a-f]{40}$') { Stop-Evidence "Could not read HEAD of $RepoRoot." }
$branchOut = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
$branch = if ($branchOut.Lines.Count -gt 0) { $branchOut.Lines[0].Trim() } else { '' }

# The evidence is for the commit the release was built from. HEAD may sit ahead of it only by commits that touch
# docs/releases (the notes), so a rerun of one gate after the notes were committed still counts for the same release.
$releaseSha = $start.Head
$stagedMatches = $false
if ($staged.sha -match '^[0-9a-f]{12}$' -and $staged.dirty -ne 'True' -and $releaseName -notmatch '-dirty-') {
    $resolved = Invoke-Git @('rev-parse', '--verify', '--quiet', ($staged.sha + '^{commit}'))
    if ($resolved.Code -eq 0 -and $resolved.Lines.Count -gt 0 -and $resolved.Lines[0].Trim() -match '^[0-9a-f]{40}$') {
        $releaseSha = $resolved.Lines[0].Trim()
        if ($releaseSha -eq $start.Head) {
            $stagedMatches = $true
        } else {
            $ancestor = Invoke-Git @('merge-base', '--is-ancestor', $releaseSha, $start.Head)
            $diff = Invoke-Git @('diff', '--name-only', $releaseSha, $start.Head)
            $stagedMatches = ($ancestor.Code -eq 0) -and (@($diff.Lines | Where-Object { $_.Trim() -and $_ -notmatch '^docs/releases/' }).Count -eq 0)
        }
    }
}

# Gate definitions ---------------------------------------------------------------------------------------------------
$e2eScript = Join-Path $PSScriptRoot 'e2e-smoke.ps1'
if ($GatesJson) {
    $defs = @((Get-Content -LiteralPath $GatesJson -Raw | ConvertFrom-Json) | ForEach-Object {
            @{ id = [string]$_.id; kind = [string]$_.kind; cwd = [string]$_.cwd; title = [string]$_.title; commands = @($_.commands | ForEach-Object { [string]$_ }) }
        })
} else {
    $psBase = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File'
    $defs = @(
        @{ id = 'server-tests'; kind = 'vitest'; cwd = 'apps\server'; title = 'Server tests'; commands = @('vp test run src/personal src/mcp') },
        @{ id = 'server-tsc'; kind = 'tsc'; cwd = 'apps\server'; title = 'Server typecheck'; commands = @('..\..\node_modules\.bin\tsc --noEmit') },
        @{ id = 'web-tests'; kind = 'vitest'; cwd = 'apps\web'; title = 'Web tests'; commands = @('vp test run --project unit src/features/personal') },
        @{ id = 'web-tsc'; kind = 'tsc'; cwd = 'apps\web'; title = 'Web typecheck'; commands = @('..\..\node_modules\.bin\tsc --noEmit') },
        @{ id = 'ps-tests'; kind = 'ps'; cwd = '.'; title = 'PowerShell script tests'; commands = @(
                "$psBase scripts\personal\release-safety.tests.ps1",
                "$psBase scripts\personal\gate-evidence.tests.ps1",
                "$psBase scripts\personal\updates\updates.tests.ps1") },
        @{ id = 'e2e'; kind = 'e2e'; cwd = '.'; title = 'Phone e2e smoke'; commands = @("$psBase `"$e2eScript`" -Release `"$releaseDir`" -Json") },
        @{ id = 'lint'; kind = 'lint'; cwd = '.'; title = 'Lint'; commands = @('vp lint --report-unused-disable-directives') }
    )
}
$defaultIds = @($defs | Where-Object { $_.id -ne 'lint' } | ForEach-Object { $_.id })
$selected = if ($Gates -and $Gates.Count -gt 0) { @($Gates | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { $defaultIds }
foreach ($id in $selected) {
    if (-not ($defs | Where-Object { $_.id -eq $id })) { Stop-Evidence "Unknown gate '$id'. Known: $(($defs | ForEach-Object { $_.id }) -join ', ')." }
}

# Tools on PATH the way build.ps1 does (the repo-local vp shim first: Smart App Control blocks the global vp.exe at times).
$nodeExe = Resolve-NodeExe -Node $Node
$env:PATH = "$(Join-Path $RepoRoot 'node_modules\.bin');$(Join-Path $env:LOCALAPPDATA 'vite-plus\bin');$(Split-Path -Parent $nodeExe);$env:PATH"

$logDir = Join-Path $releaseDir 'gate-evidence-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ansi = [regex]'\x1B\[[0-9;?]*[A-Za-z]'

function Get-VitestCounts([string[]]$Lines) {
    $counts = [ordered]@{ testFiles = 0; tests = 0; passed = 0; failed = 0; skipped = 0 }
    foreach ($line in $Lines) {
        $plain = $ansi.Replace($line, '').Trim()
        if ($plain -match '^Test Files\s+(.*)$') {
            $rest = $Matches[1]
            if ($rest -match '\((\d+)\)') { $counts.testFiles = [int]$Matches[1] }
        } elseif ($plain -match '^Tests\s+(.*)$') {
            $rest = $Matches[1]
            if ($rest -match '\((\d+)\)') { $counts.tests = [int]$Matches[1] }
            if ($rest -match '(\d+)\s+passed') { $counts.passed = [int]$Matches[1] }
            if ($rest -match '(\d+)\s+failed') { $counts.failed = [int]$Matches[1] }
            if ($rest -match '(\d+)\s+(skipped|todo)') { $counts.skipped += [int]$Matches[1] }
        }
    }
    return $counts
}

function Invoke-OneGate($Def) {
    $log = Join-Path $logDir ($Def.id + '.log')
    Set-Content -LiteralPath $log -Value '' -Encoding ASCII
    $cwd = if ($Def.cwd -and $Def.cwd -ne '.') { Join-Path $RepoRoot $Def.cwd } else { $RepoRoot }
    $started = Get-Date
    $ran = @()
    $firstBad = 0
    foreach ($command in $Def.commands) {
        # One batch file per command: `call` lets .CMD shims (vp, tsc) return here, and cmd writes the log bytes itself.
        $batch = Join-Path $logDir ($Def.id + '.' + ($ran.Count + 1) + '.cmd')
        $body = "@echo off`r`ncd /d `"$cwd`"`r`necho == $command >> `"$log`"`r`ncall $command >> `"$log`" 2>&1`r`nexit /b %errorlevel%`r`n"
        [System.IO.File]::WriteAllText($batch, $body, [System.Text.Encoding]::ASCII)
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & cmd.exe /d /c "`"$batch`"" | Out-Null
            $code = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previous }
        Remove-Item -LiteralPath $batch -Force -ErrorAction SilentlyContinue
        if ($null -eq $code) { $code = 1 }
        $ran += [ordered]@{ command = $command; exit = [int]$code }
        if ($code -ne 0 -and $firstBad -eq 0) { $firstBad = [int]$code }
        Write-Host ("  [{0}] exit {1}: {2}" -f $Def.id, $code, $command)
    }
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $lines = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | ForEach-Object { $ansi.Replace("$_", '') })
    $gate = [ordered]@{
        id = $Def.id; title = $Def.title; kind = $Def.kind; cwd = $Def.cwd
        commands = $ran; exit = $firstBad; seconds = $seconds; log = $log
    }
    if ($Def.kind -eq 'vitest') {
        $gate['counts'] = Get-VitestCounts $lines
    } elseif ($Def.kind -eq 'ps') {
        $gate['counts'] = [ordered]@{ checks = @($lines | Where-Object { $_ -match '^\s+ok\s' }).Count; failedChecks = @($lines | Where-Object { $_ -match '^\s+FAIL\s' }).Count }
    } elseif ($Def.kind -eq 'e2e') {
        $summaryLine = $lines | Where-Object { $_ -match '^\s*\{.*\}\s*$' } | Select-Object -Last 1
        $journeys = @()
        $e2eFailed = 0
        if ($summaryLine) {
            try {
                $summary = $summaryLine | ConvertFrom-Json
                $journeys = @($summary.journeys | ForEach-Object { [ordered]@{ id = [string]$_.id; ok = [bool]$_.ok; ms = $_.ms } })
                $e2eFailed = [int]$summary.failed
                $gate['e2eExit'] = [int]$summary.exit
            } catch { $journeys = @() }
        }
        $gate['journeys'] = $journeys
        $gate['counts'] = [ordered]@{ journeys = $journeys.Count; passed = @($journeys | Where-Object { $_.ok }).Count; failed = $e2eFailed }
    }
    $gate['tail'] = @($lines | Where-Object { $_.Trim() } | Select-Object -Last 8)
    return $gate
}

# Carry earlier results forward (-Merge) --------------------------------------------------------------------------------
$evidencePath = Join-Path $releaseDir 'gate-evidence.json'
$kept = @{}
if ($Merge -and (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
    try {
        $old = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
        if ($old.sha -eq $releaseSha -and $old.treeClean -eq $true -and $old.binSha256 -eq $binSha256) {
            foreach ($g in @($old.gates)) { if ($selected -notcontains [string]$g.id) { $kept[[string]$g.id] = $g } }
        } else {
            Write-Warning 'Earlier evidence is for another commit, a dirty tree or another binary; -Merge ignores it.'
        }
    } catch { Write-Warning "Earlier evidence could not be read ($($_.Exception.Message)); -Merge ignores it." }
}

if ($start.Dirty.Count -gt 0) {
    Write-Warning ("Tracked files are modified ({0}): the evidence is recorded with treeClean=false and the release will be refused. Commit first." -f (($start.Dirty | Select-Object -First 3) -join '; '))
}
$startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Write-Host ("Gate evidence for {0} (release {1}, commit {2}): {3}" -f $Version, $releaseName, $releaseSha.Substring(0, 12), ($selected -join ', '))

$results = @()
foreach ($def in $defs) {
    if ($selected -contains $def.id) { $results += , (Invoke-OneGate $def) }
    elseif ($kept.ContainsKey($def.id)) { $results += , $kept[$def.id] }
}

$end = Get-TreeState
$cleanAtEnd = ($end.Dirty.Count -eq 0)
$treeClean = ($start.Dirty.Count -eq 0) -and $cleanAtEnd
$sameHead = ($end.Head -eq $start.Head)
# Verdict, derived from exit codes and counts (the same rules check-gate-evidence.ps1 applies).
function Test-GatePass($g) {
    if ([int]$g.exit -ne 0) { return $false }
    if ($g.kind -eq 'vitest') { return ([int]$g.counts.passed -gt 0 -and [int]$g.counts.failed -eq 0) }
    if ($g.kind -eq 'e2e') { return ([int]$g.counts.journeys -ge 1 -and [int]$g.counts.failed -eq 0 -and [int]$g.counts.passed -eq [int]$g.counts.journeys) }
    return $true
}
$gateRows = @()
foreach ($g in $results) {
    $gateRows += , ([pscustomobject]@{ g = $g; pass = (Test-GatePass $g) })
}
$allPass = (@($gateRows | Where-Object { -not $_.pass }).Count -eq 0) -and $gateRows.Count -gt 0
$ok = $allPass -and $treeClean -and $sameHead -and $stagedMatches

$evidence = [ordered]@{
    schema = 1
    version = $Version
    release = $releaseName
    sha = $releaseSha
    branch = $branch
    treeClean = $treeClean
    dirtyPaths = @($start.Dirty + $end.Dirty | Select-Object -Unique | Select-Object -First 10)
    headAtStart = $start.Head
    headAtEnd = $end.Head
    stagedRelease = $staged
    binSha256 = $binSha256
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    ok = $ok
    gates = @($results | ForEach-Object { $_ })
}
$jsonText = $evidence | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($evidencePath, $jsonText + "`n", (New-Object System.Text.UTF8Encoding($false)))
$jsonHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Evidence written: $evidencePath (sha256 $jsonHash)"

# The "Gate evidence" section of the release notes -----------------------------------------------------------------------
function Format-GateCounts($g) {
    if ($g.kind -eq 'vitest') { return ('{0} tests passed, {1} failed, {2} skipped, in {3} files' -f $g.counts.passed, $g.counts.failed, $g.counts.skipped, $g.counts.testFiles) }
    if ($g.kind -eq 'e2e') { return ('{0}/{1} journeys passed' -f $g.counts.passed, $g.counts.journeys) }
    if ($g.kind -eq 'ps') { return ('{0} checks ok, {1} failed' -f $g.counts.checks, $g.counts.failedChecks) }
    return 'exit code only'
}
$notesPath = Join-Path $RepoRoot ("docs\releases\$notesName")
if (-not $SkipNotes) {
    $result = if ($ok) { 'PASS' } else { 'FAIL' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("<!-- gate-evidence:begin sha=$releaseSha release=$releaseName json-sha256=$jsonHash result=$result -->")
    [void]$sb.AppendLine("Written by ``scripts/personal/gate-evidence.ps1`` at $($evidence.finishedAt). Version $Version, release ``$releaseName``, commit ``$releaseSha`` on ``$branch``, working tree $(if ($treeClean) { 'clean' } else { 'NOT clean' }), result **$result**.")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("Machine-readable copy: ``releases\$releaseName\gate-evidence.json`` (sha256 ``$jsonHash``) and the full gate logs in ``releases\$releaseName\gate-evidence-logs\``. ``check-gate-evidence.ps1`` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only ``docs/releases`` may change after it.")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| Gate | Commands | Exit | Result | Seconds |')
    [void]$sb.AppendLine('| --- | --- | --- | --- | --- |')
    foreach ($row in $gateRows) {
        $g = $row.g
        $cmds = (@($g.commands | ForEach-Object { '`' + $_.command + '`' }) -join '; ')
        [void]$sb.AppendLine(('| {0} | {1} (in `{2}`) | {3} | {4}: {5} | {6} |' -f $g.id, $cmds, $g.cwd, $g.exit, $(if ($row.pass) { 'pass' } else { 'FAIL' }), (Format-GateCounts $g), $g.seconds))
    }
    $e2eGate = $results | Where-Object { $_.kind -eq 'e2e' } | Select-Object -First 1
    if ($e2eGate -and @($e2eGate.journeys).Count -gt 0) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('E2E journeys: ' + ((@($e2eGate.journeys) | ForEach-Object { '`' + $_.id + '` ' + $(if ($_.ok) { 'ok' } else { 'FAILED' }) }) -join ', ') + '.')
    }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("Tree: HEAD at start ``$($start.Head)``, at end ``$($end.Head)``; tracked files modified: $(if ($start.Dirty.Count + $end.Dirty.Count -eq 0) { 'none' } else { (@($start.Dirty + $end.Dirty | Select-Object -Unique | Select-Object -First 5) -join '; ') }). Staged release: version $($staged.version), sha $($staged.sha), dirty $($staged.dirty), externals $($staged.externals); ``dist/bin.mjs`` sha256 ``$binSha256``.")
    [void]$sb.Append('<!-- gate-evidence:end -->')
    $section = $sb.ToString()

    $existing = if (Test-Path -LiteralPath $notesPath -PathType Leaf) { [System.IO.File]::ReadAllText($notesPath) } else { $null }
    if ($null -eq $existing) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $notesPath) | Out-Null
        $existing = "# HANDOFF $Version`r`n`r`n## What changed`r`n`r`nPROOF_PLACEHOLDER: replace this line with what changed, the proof and what QA should look at.`r`n"
    }
    $pattern = '(?s)<!-- gate-evidence:begin[^>]*-->.*?<!-- gate-evidence:end -->'
    $eol = if ($existing -match "`r`n") { "`r`n" } else { "`n" }
    $sectionText = $section -replace "`r?`n", $eol
    if ([regex]::IsMatch($existing, $pattern)) {
        $updated = [regex]::Replace($existing, $pattern, { param($m) $sectionText })
    } else {
        $updated = $existing.TrimEnd() + $eol + $eol + '## Gate evidence' + $eol + $eol + $sectionText + $eol
    }
    [System.IO.File]::WriteAllText($notesPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Notes updated: $notesPath (commit it; only docs/releases may change after the gates ran)."
}

foreach ($row in $gateRows) { Write-Host ("  {0,-13} {1}  {2}" -f $row.g.id, $(if ($row.pass) { 'pass' } else { 'FAIL' }), (Format-GateCounts $row.g)) }
Write-Host ("tree clean: {0}; HEAD unchanged: {1}; staged release matches HEAD: {2}" -f $treeClean, $sameHead, $stagedMatches)
Write-Host ("Gate evidence result: {0}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }))
if ($Json) {
    Write-Output ([ordered]@{ ok = $ok; version = $Version; release = $releaseName; sha = $releaseSha; treeClean = $treeClean; evidence = $evidencePath; sha256 = $jsonHash } | ConvertTo-Json -Compress)
}
exit $(if ($ok) { 0 } else { 1 })
