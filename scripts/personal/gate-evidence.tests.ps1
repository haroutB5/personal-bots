<#
.SYNOPSIS
Tests for gate-evidence.ps1 (writes the evidence) and check-gate-evidence.ps1 (refuses a release without good evidence).

.DESCRIPTION
No server, no release and no data root is touched. Every case builds a throwaway git repo, a throwaway releases folder
and fake gates (a tiny node script that prints vitest-like or e2e-like output) under %TEMP%, runs the real generator
and the real checker, and deletes the folder at the end. Exits non-zero on any failure.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')
$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:total = 0

function Assert-Equal {
    param([string]$What, $Expected, $Actual)
    $script:total++
    if (($Expected -join ',') -eq ($Actual -join ',')) {
        Write-Host "  ok   $What"
    } else {
        Write-Host "  FAIL $What"
        Write-Host "       expected: [$($Expected -join ',')]"
        Write-Host "       actual:   [$($Actual -join ',')]"
        $script:failures++
    }
}

$generator = Join-Path $PSScriptRoot 'gate-evidence.ps1'
$checker = Join-Path $PSScriptRoot 'check-gate-evidence.ps1'
$notesChecker = Join-Path $PSScriptRoot 'check-release-notes.ps1'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hbots-evidence-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$fakeGate = Join-Path $tmp 'fake-gate.js'
[System.IO.File]::WriteAllText($fakeGate, @'
const [kind, mode, count] = process.argv.slice(2);
const E = "\u001b";
if (kind === "vitest") {
  if (mode === "zero") { console.log("No test files found, exiting with code 0"); process.exit(0); }
  if (mode === "fail") {
    console.log(` ${E}[2mTest Files${E}[22m  ${E}[1m${E}[31m1 failed${E}[39m${E}[22m | ${E}[1m${E}[32m2 passed${E}[39m${E}[22m${E}[90m (3)${E}[39m`);
    console.log(`      ${E}[2mTests${E}[22m  ${E}[1m${E}[31m1 failed${E}[39m${E}[22m | ${E}[1m${E}[32m11 passed${E}[39m${E}[22m${E}[90m (12)${E}[39m`);
    process.exit(1);
  }
  console.log(` ${E}[2mTest Files${E}[22m  ${E}[1m${E}[32m3 passed${E}[39m${E}[22m${E}[90m (3)${E}[39m`);
  console.log(`      ${E}[2mTests${E}[22m  ${E}[1m${E}[32m12 passed${E}[39m${E}[22m${E}[90m (12)${E}[39m`);
  process.exit(0);
}
if (kind === "e2e") {
  const n = Number(count || 5);
  const ids = ["bots-list-chat", "new-chat-named", "delegate-task", "chats-search", "long-press-reply", "extra-1", "extra-2"].slice(0, n);
  const journeys = ids.map((id, i) => ({ id, ok: !(mode === "fail" && i === 0), ms: 1000 + i }));
  const failed = journeys.filter((j) => !j.ok).length;
  const exit = failed ? 1 : 0;
  console.log("e2e smoke exit " + exit);
  console.log(JSON.stringify({ exit, seconds: 1, passed: n - failed, failed, journeys }));
  process.exit(exit);
}
if (mode === "fail") { console.log("error TS2322: Type 'string' is not assignable"); process.exit(2); }
process.exit(0);
'@, (New-Object System.Text.UTF8Encoding($false)))

function Invoke-Git {
    param([string]$Repo, [string[]]$GitArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& git -C $Repo @GitArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "git $($GitArgs -join ' ') failed ($code): $($out -join ' | ')" }
    return $out
}
function Get-Head {
    param([string]$Repo)
    return ([string](@(Invoke-Git $Repo @('rev-parse', 'HEAD'))[0])).Trim()
}
function Invoke-Ps {
    param([string]$Script, [string[]]$ScriptArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @ScriptArgs 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ Code = $code; Out = $out.Trim() }
}
function New-Fixture {
    param([hashtable]$Modes = @{}, [int]$Journeys = 5, [string[]]$Omit = @())
    $root = Join-Path $tmp ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $repo = Join-Path $root 'repo'
    $releases = Join-Path $root 'releases'
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'apps'), (Join-Path $repo 'docs\releases'), $releases | Out-Null
    [void](Invoke-Git $repo @('init', '-q'))
    [void](Invoke-Git $repo @('config', 'user.email', 'test@example.com'))
    [void](Invoke-Git $repo @('config', 'user.name', 'test'))
    [System.IO.File]::WriteAllText((Join-Path $repo 'apps\code.txt'), "one`n")
    [System.IO.File]::WriteAllText((Join-Path $repo 'docs\releases\README.md'), "notes`n")
    [void](Invoke-Git $repo @('add', '-A'))
    [void](Invoke-Git $repo @('commit', '-q', '-m', 'code'))
    $sha = Get-Head $repo
    $sha12 = $sha.Substring(0, 12)
    $releaseDir = Join-Path $releases $sha12
    New-Item -ItemType Directory -Force -Path (Join-Path $releaseDir 'dist') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $releaseDir 'dist\bin.mjs'), "// bundle $sha12`n")
    [System.IO.File]::WriteAllLines((Join-Path $releaseDir 'VERSION'), @('version=9.9.9', "release=$sha12", "sha=$sha12", 'branch=test', 'dirty=False', 'externals=copied'))
    $defs = @()
    foreach ($id in @('server-tests', 'server-tsc', 'web-tests', 'web-tsc', 'e2e')) {
        if ($Omit -contains $id) { continue }
        $kind = if ($id -like '*-tests') { 'vitest' } elseif ($id -eq 'e2e') { 'e2e' } else { 'tsc' }
        $mode = if ($Modes.ContainsKey($id)) { $Modes[$id] } else { 'ok' }
        $defs += [ordered]@{ id = $id; kind = $kind; cwd = '.'; title = $id; commands = @("node `"$fakeGate`" $kind $mode $Journeys") }
    }
    $gatesFile = Join-Path $root 'gates.json'
    [System.IO.File]::WriteAllText($gatesFile, ($defs | ConvertTo-Json -Depth 5))
    return [pscustomobject]@{ Root = $root; Repo = $repo; Releases = $releases; Sha = $sha; Sha12 = $sha12; ReleaseDir = $releaseDir; Gates = $gatesFile }
}
function Invoke-Generator {
    param($Fx, [string[]]$Extra = @())
    return Invoke-Ps $generator (@('-Version', '9.9.9', '-Release', $Fx.Sha12, '-RepoRoot', $Fx.Repo, '-ReleasesDir', $Fx.Releases, '-GatesJson', $Fx.Gates) + $Extra)
}
function Invoke-Checker {
    param($Fx, [string]$Commit, [string]$Release, [string]$Version = '9.9.9')
    if (-not $Release) { $Release = $Fx.Sha12 }
    $a = @('-Version', $Version, '-Release', $Release, '-RepoRoot', $Fx.Repo, '-ReleasesDir', $Fx.Releases)
    if ($Commit) { $a += @('-Commit', $Commit) }
    return Invoke-Ps $checker $a
}
function Save-Notes {
    # Commits the notes the generator wrote (docs\releases only) and returns the new HEAD.
    param($Fx)
    [void](Invoke-Git $Fx.Repo @('add', '-A'))
    [void](Invoke-Git $Fx.Repo @('commit', '-q', '-m', 'notes'))
    return Get-Head $Fx.Repo
}

try {
    Write-Host 'good evidence'
    $fx = New-Fixture
    $gen = Invoke-Generator $fx
    Assert-Equal 'the generator passes (exit 0)' 0 $gen.Code
    Assert-Equal 'it prints the verdict' $true ($gen.Out -match 'Gate evidence result: PASS')
    $jsonPath = Join-Path $fx.ReleaseDir 'gate-evidence.json'
    Assert-Equal 'gate-evidence.json sits next to the staged release' $true (Test-Path -LiteralPath $jsonPath)
    $ev = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
    Assert-Equal 'it records the full commit' $fx.Sha $ev.sha
    Assert-Equal 'it records the clean tree' $true $ev.treeClean
    Assert-Equal 'it records five gates' 5 @($ev.gates).Count
    $vit = @($ev.gates | Where-Object { $_.id -eq 'server-tests' })[0]
    Assert-Equal 'it counts the tests (ANSI codes stripped)' '12/0/3' ("$($vit.counts.passed)/$($vit.counts.failed)/$($vit.counts.testFiles)")
    Assert-Equal 'it records the command and its exit code' '0' ([string]$vit.commands[0].exit)
    Assert-Equal 'it records the e2e journeys' 5 @(@($ev.gates | Where-Object { $_.id -eq 'e2e' })[0].journeys).Count
    Assert-Equal 'it records the artifact hash' 64 ([string]$ev.binSha256).Length
    Assert-Equal 'the gate logs are kept' $true (Test-Path -LiteralPath (Join-Path $fx.ReleaseDir 'gate-evidence-logs\server-tests.log'))
    $notesFile = Join-Path $fx.Repo 'docs\releases\HANDOFF-999.md'
    $notesText = [System.IO.File]::ReadAllText($notesFile)
    Assert-Equal 'a Gate evidence section is written into the notes' $true ($notesText -match '(?m)^## Gate evidence')
    Assert-Equal 'the section names the commit and the result' $true ($notesText -match ('gate-evidence:begin sha=' + $fx.Sha + ' release=' + $fx.Sha12 + ' json-sha256=[0-9a-f]{64} result=PASS'))
    Assert-Equal 'the section lists the e2e journeys' $true ($notesText -match 'bots-list-chat. ok')
    $notesRun = Invoke-Ps $notesChecker @('-Version', '9.9.9', '-Path', $notesFile)
    Assert-Equal 'a notes file created by the generator holds PROOF_PLACEHOLDER, so the notes check refuses it' 1 $notesRun.Code
    $main = Save-Notes $fx
    $r = Invoke-Checker $fx $main
    Assert-Equal 'ACCEPTED: good evidence, notes-only commit after it (exit 0)' 0 $r.Code
    Assert-Equal 'the pass line names the commit' $true ($r.Out -match ('^PASS: .*' + $fx.Sha.Substring(0, 12)))
    $r = Invoke-Checker $fx
    Assert-Equal 'accepted without -Commit too' 0 $r.Code

    Write-Host 'rerun replaces the section, never duplicates it'
    $gen = Invoke-Generator $fx -Extra @('-Gates', 'e2e', '-Merge')
    Assert-Equal 'a rerun of one gate with -Merge passes' 0 $gen.Code
    $ev = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
    Assert-Equal '-Merge keeps the other four gates' 5 @($ev.gates).Count
    $notesText = [System.IO.File]::ReadAllText($notesFile)
    Assert-Equal 'one section only' 1 ([regex]::Matches($notesText, 'gate-evidence:begin')).Count
    $r = Invoke-Checker $fx $main
    Assert-Equal 'REFUSED: the evidence file was regenerated but the notes still hold the old hash' 1 $r.Code
    Assert-Equal 'the message says the evidence changed since the notes' $true ($r.Out -match 'changed since the notes were written')
    $main2 = Save-Notes $fx
    $r = Invoke-Checker $fx $main2
    Assert-Equal 'accepted again once the new notes are committed' 0 $r.Code

    Write-Host 'missing evidence'
    $fx = New-Fixture
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: no gate-evidence.json (exit 1)' 1 $r.Code
    Assert-Equal 'the message says it is missing' $true ($r.Out -match 'gate evidence is missing')

    Write-Host 'failed evidence'
    foreach ($case in @(
            @{ Name = 'a failed test run'; Modes = @{ 'web-tests' = 'fail' }; Match = "gate 'web-tests' failed" },
            @{ Name = 'a failed typecheck'; Modes = @{ 'server-tsc' = 'fail' }; Match = "gate 'server-tsc' failed" },
            @{ Name = 'a failed e2e journey'; Modes = @{ 'e2e' = 'fail' }; Match = "gate 'e2e' failed" },
            @{ Name = 'a test run that ran no tests'; Modes = @{ 'server-tests' = 'zero' }; Match = 'ran no passing tests' })) {
        $fx = New-Fixture -Modes $case.Modes
        $gen = Invoke-Generator $fx
        Assert-Equal "the generator exits 1 for $($case.Name) and still writes the evidence" '1,True' ("$($gen.Code),$(Test-Path -LiteralPath (Join-Path $fx.ReleaseDir 'gate-evidence.json'))")
        $main = Save-Notes $fx
        $r = Invoke-Checker $fx $main
        Assert-Equal "REFUSED: $($case.Name)" 1 $r.Code
        Assert-Equal "the message names the failure ($($case.Match))" $true ($r.Out -match [regex]::Escape($case.Match))
    }
    $fx = New-Fixture -Omit @('e2e')
    [void](Invoke-Generator $fx)
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: a required gate (e2e) has no result' 1 $r.Code
    Assert-Equal 'the message names the missing gate' $true ($r.Out -match "required gate 'e2e' has no result")
    $fx = New-Fixture -Journeys 4
    [void](Invoke-Generator $fx)
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: fewer than five e2e journeys' 1 $r.Code
    $fx = New-Fixture
    [void](Invoke-Generator $fx)
    $jsonPath = Join-Path $fx.ReleaseDir 'gate-evidence.json'
    $tampered = [System.IO.File]::ReadAllText($jsonPath) -replace '"exit":\s*0,(\s*"seconds")', '"exit": 3,$1'
    [System.IO.File]::WriteAllText($jsonPath, $tampered)
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: a gate exit code edited in the file' 1 $r.Code
    $fx = New-Fixture -Modes @{ 'web-tests' = 'fail' }
    [void](Invoke-Generator $fx)
    $jsonPath = Join-Path $fx.ReleaseDir 'gate-evidence.json'
    $ev = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
    $ev.ok = $true
    $ev | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: "ok": true on a file whose gate failed is not trusted' 1 $r.Code

    Write-Host 'dirty tree'
    $fx = New-Fixture
    [System.IO.File]::WriteAllText((Join-Path $fx.Repo 'apps\code.txt'), "edited after the commit`n")
    $gen = Invoke-Generator $fx
    Assert-Equal 'the generator exits 1 on a modified tracked file' 1 $gen.Code
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: tree not clean' 1 $r.Code
    Assert-Equal 'the message says so' $true ($r.Out -match 'working tree was not clean')

    Write-Host 'evidence for a different commit'
    $fx = New-Fixture
    [void](Invoke-Generator $fx)
    $other12 = ('f' * 12)
    Copy-Item -LiteralPath $fx.ReleaseDir -Destination (Join-Path $fx.Releases $other12) -Recurse
    $r = Invoke-Checker $fx -Release $other12
    Assert-Equal 'REFUSED: another release folder holding this build''s evidence' 1 $r.Code
    Assert-Equal 'the message says the commit differs' $true ($r.Out -match 'different commit than release')
    $jsonOther = Join-Path (Join-Path $fx.Releases $other12) 'gate-evidence.json'
    $relabelled = [System.IO.File]::ReadAllText($jsonOther) -replace '"release":\s*"[0-9a-f]{12}"', ('"release": "' + $other12 + '"')
    [System.IO.File]::WriteAllText($jsonOther, $relabelled)
    $r = Invoke-Checker $fx -Release $other12
    Assert-Equal 'REFUSED: the release name edited to match, the commit still differs' 1 $r.Code
    Assert-Equal 'the commit mismatch is caught' $true ($r.Out -match 'different commit than release')
    $fxWrongVersion = Invoke-Checker $fx -Version '9.9.8'
    Assert-Equal 'REFUSED: evidence for another version' 1 $fxWrongVersion.Code

    Write-Host 'code changed after the gates ran'
    $fx = New-Fixture
    [void](Invoke-Generator $fx)
    [System.IO.File]::WriteAllText((Join-Path $fx.Repo 'apps\code.txt'), "two`n")
    [void](Invoke-Git $fx.Repo @('add', '-A'))
    [void](Invoke-Git $fx.Repo @('commit', '-q', '-m', 'late code change'))
    $late = Get-Head $fx.Repo
    $r = Invoke-Checker $fx $late
    Assert-Equal 'REFUSED: a code file changed between the evidence commit and the shipped commit' 1 $r.Code
    Assert-Equal 'the message names the file' $true ($r.Out -match 'code changed after the gates ran.*apps/code.txt')
    $fx2 = New-Fixture
    [void](Invoke-Generator $fx2)
    $main = Save-Notes $fx2
    [System.IO.File]::WriteAllText((Join-Path $fx2.Repo 'docs\releases\HANDOFF-999.md'), ([System.IO.File]::ReadAllText((Join-Path $fx2.Repo 'docs\releases\HANDOFF-999.md')) + "`nMore words from QA.`n"))
    $main = Save-Notes $fx2
    $r = Invoke-Checker $fx2 $main
    Assert-Equal 'ACCEPTED: only docs/releases changed after the gates' 0 $r.Code
    $r = Invoke-Checker $fx2 ('0' * 40)
    Assert-Equal 'REFUSED: a commit that is not in the repo' 1 $r.Code

    Write-Host 'notes'
    $fx = New-Fixture
    [void](Invoke-Generator $fx)
    Remove-Item -LiteralPath (Join-Path $fx.Repo 'docs\releases\HANDOFF-999.md') -Force
    [System.IO.File]::WriteAllText((Join-Path $fx.Repo 'docs\releases\HANDOFF-999.md'), "# Notes`n`nWritten by hand, no evidence section.`n")
    $main = Save-Notes $fx
    $r = Invoke-Checker $fx $main
    Assert-Equal 'REFUSED: the notes at the shipped commit have no Gate evidence section' 1 $r.Code
    Assert-Equal 'the message says so' $true ($r.Out -match 'no Gate evidence section')

    Write-Host 'the artifact'
    $fx = New-Fixture
    [void](Invoke-Generator $fx)
    [System.IO.File]::WriteAllText((Join-Path $fx.ReleaseDir 'dist\bin.mjs'), "// rebuilt later`n")
    $r = Invoke-Checker $fx
    Assert-Equal 'REFUSED: dist\bin.mjs changed after the gates ran' 1 $r.Code
    Assert-Equal 'the message says so' $true ($r.Out -match 'bin.mjs changed after the gates')

    Write-Host 'arguments and rollback'
    $r = Invoke-Checker $fx -Release 'abc'
    Assert-Equal 'a bad release is a usage error (exit 2)' 2 $r.Code
    $r = Invoke-Checker $fx -Version 'x'
    Assert-Equal 'a bad version is a usage error (exit 2)' 2 $r.Code
    $restartText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'restart.ps1') -Raw
    Assert-Equal 'restart.ps1 (the rollback path) never calls the evidence check' $false ($restartText -match 'check-gate-evidence')
    $buildText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build.ps1') -Raw
    Assert-Equal 'build.ps1 (staging) never calls the evidence check' $false ($buildText -match 'check-gate-evidence')
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
    Write-Host "$($script:failures) failure(s) of $($script:total)."
    exit 1
}
Write-Host "All passed ($($script:total) checks)."
exit 0
