<#
.SYNOPSIS
Refuses a release whose gate evidence (gate-evidence.ps1) is missing, failed, or recorded for a different commit.

.DESCRIPTION
Run by the release waiter BEFORE `restart.ps1 -Release <new sha>` goes live, right after check-release-notes.ps1. Never
on a rollback and never at staging time: restart.ps1 does not call it, so `restart.ps1 -Release <older sha>` (the
rollback) can never be held up by evidence. A waiter that rolls back simply does not run this step.

It reads <ReleasesDir>\<release>\gate-evidence.json (written by gate-evidence.ps1 next to the staged release) and
refuses (exit 1) when:
  - the file is missing, unreadable or has another schema;
  - it names another release, another version, or its commit does not start with the release sha12 (a release
    folder with the evidence of a different build);
  - the staged dist\bin.mjs no longer has the SHA-256 the gates ran on (the artifact changed after the gates);
  - the tree was not clean, HEAD moved while the gates ran, or the staged build itself was dirty;
  - a required gate (server-tests, server-tsc, web-tests, web-tsc, e2e) is missing, exited non-zero, ran no tests,
    or reports failed tests or failed journeys; or ANY recorded gate failed. The verdict is recomputed here from the
    exit codes and counts, the file's own "ok" flag is not trusted;
  - with -Commit (the main sha the waiter ships): the evidence commit is not an ancestor of it, files other than
    docs\releases\* changed after the gates ran, or the notes at that commit have no "Gate evidence" section that
    names the same commit, release and evidence hash with result PASS.

Exit code: 0 evidence is good, 1 refused, 2 bad arguments.

.EXAMPLE
# in the waiter, from the pinned tools copy:
powershell -NoProfile -ExecutionPolicy Bypass -File "$pbRun\release-tools-1.66.2\scripts\personal\check-gate-evidence.ps1" -Version 1.66.2 -Release <sha12> -Commit <main sha> -RepoRoot C:\Claude\AI\personal-bots
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Release,
    # The main sha being shipped: its notes must carry the evidence section and only docs\releases may differ from the evidence commit.
    [string]$Commit,
    # Repo to read from (git). Default: the repo this script sits in; pass it when running from a release-tools copy.
    [string]$RepoRoot,
    # Test hook: releases folder (default ~\.personal-bots\releases).
    [string]$ReleasesDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$MinJourneys = 5
$RequiredGates = @('server-tests', 'server-tsc', 'web-tests', 'web-tsc', 'e2e')

if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Host "FAIL: -Version must look like 1.66.2 (got '$Version')."
    exit 2
}
$notesNames = @("HANDOFF-$($Matches[1])$($Matches[2])$($Matches[3]).md")
if ($Matches[3] -eq '0') { $notesNames += "HANDOFF-$($Matches[1])$($Matches[2]).md" }
if ($Release -notmatch '^[0-9a-f]{12}$') {
    Write-Host "FAIL: -Release must be the 12-character release sha, got '$Release' (a dirty build cannot be shipped)."
    exit 2
}
if (-not $RepoRoot) { $RepoRoot = $PbRepoRoot }
if (-not $ReleasesDir) { $ReleasesDir = (Get-PbPaths -Root dev).ReleasesDir }

$failures = New-Object System.Collections.Generic.List[string]
function Add-Failure([string]$Message) { $failures.Add($Message) }
function Finish {
    if ($failures.Count -gt 0) {
        Write-Host ("FAIL: release {0} ({1}) is refused: gate evidence is not good." -f $Release, $Version)
        $failures | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }
        exit 1
    }
}

$releaseDir = Join-Path $ReleasesDir $Release
$evidencePath = Join-Path $releaseDir 'gate-evidence.json'
if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
    Write-Host ("FAIL: release {0} ({1}) is refused: gate evidence is missing ({2} not found). Run gate-evidence.ps1 on the staged release first." -f $Release, $Version, $evidencePath)
    exit 1
}
try {
    $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
} catch {
    Write-Host ("FAIL: release {0} ({1}) is refused: gate evidence cannot be read ({2})." -f $Release, $Version, $_.Exception.Message)
    exit 1
}
if ($evidence.schema -ne 1) { Add-Failure "unknown evidence schema '$($evidence.schema)' (expected 1)." }
if ($evidence.release -ne $Release) { Add-Failure "evidence is for release '$($evidence.release)', not $Release." }
if ($evidence.version -ne $Version) { Add-Failure "evidence is for version '$($evidence.version)', not $Version." }
$evidenceSha = [string]$evidence.sha
if ($evidenceSha -notmatch '^[0-9a-f]{40}$') { Add-Failure "evidence has no full commit sha." }
elseif (-not $evidenceSha.StartsWith($Release)) { Add-Failure "evidence was recorded for commit $($evidenceSha.Substring(0, 12)), a different commit than release $Release." }
if (-not $evidence.headAtStart -or $evidence.headAtStart -ne $evidence.headAtEnd) { Add-Failure "HEAD moved while the gates ran (start $($evidence.headAtStart), end $($evidence.headAtEnd))." }
if ($evidence.treeClean -ne $true) { Add-Failure ("the working tree was not clean when the gates ran ({0})." -f (@($evidence.dirtyPaths) -join '; ')) }
if ($evidence.stagedRelease -and "$($evidence.stagedRelease.dirty)" -eq 'True') { Add-Failure 'the staged release was built from a dirty tree.' }
if ($evidence.stagedRelease -and $evidence.stagedRelease.sha -and $evidenceSha -and -not $evidenceSha.StartsWith([string]$evidence.stagedRelease.sha)) {
    Add-Failure "the staged release was built from $($evidence.stagedRelease.sha), not the commit the gates ran on."
}

# The tested artifact is the one that would be started.
$binPath = Join-Path $releaseDir 'dist\bin.mjs'
if (-not (Test-Path -LiteralPath $binPath -PathType Leaf)) {
    Add-Failure "release has no dist\bin.mjs to compare with the evidence."
} else {
    $binHash = (Get-FileHash -LiteralPath $binPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($binHash -ne [string]$evidence.binSha256) { Add-Failure "dist\bin.mjs changed after the gates ran (sha256 $($binHash.Substring(0, 12)) now, $(([string]$evidence.binSha256).Substring(0, [math]::Min(12, ([string]$evidence.binSha256).Length))) in the evidence)." }
}

# Verdict recomputed from exit codes and counts.
$gates = @($evidence.gates)
foreach ($required in $RequiredGates) {
    if (-not ($gates | Where-Object { $_.id -eq $required })) { Add-Failure "required gate '$required' has no result." }
}
foreach ($g in $gates) {
    $id = [string]$g.id
    if ([int]$g.exit -ne 0) { Add-Failure "gate '$id' failed (exit $($g.exit))."; continue }
    foreach ($c in @($g.commands)) { if ([int]$c.exit -ne 0) { Add-Failure "gate '$id' command '$($c.command)' exited $($c.exit)." } }
    if ($g.kind -eq 'vitest') {
        if ([int]$g.counts.passed -le 0) { Add-Failure "gate '$id' ran no passing tests." }
        if ([int]$g.counts.failed -ne 0) { Add-Failure "gate '$id' reports $($g.counts.failed) failed test(s)." }
    } elseif ($g.kind -eq 'e2e') {
        $journeys = @($g.journeys)
        if ($journeys.Count -lt $MinJourneys) { Add-Failure "gate 'e2e' ran $($journeys.Count) journey(s), expected at least $MinJourneys." }
        foreach ($j in $journeys) { if (-not $j.ok) { Add-Failure "e2e journey '$($j.id)' failed." } }
        if ([int]$g.counts.failed -ne 0) { Add-Failure "gate 'e2e' reports $($g.counts.failed) failed journey(s)." }
    }
}
if ($evidence.ok -ne $true) { Add-Failure 'the evidence itself says ok=false.' }

# The notes and the commit being shipped.
if ($Commit) {
    function Invoke-Git([string[]]$GitArgs) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = @(& git -C $RepoRoot @GitArgs 2>$null)
            $code = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previous }
        return [pscustomobject]@{ Code = $code; Lines = @($out | ForEach-Object { "$_" }) }
    }
    if (-not (Test-Path -LiteralPath $RepoRoot)) {
        Write-Host "FAIL: no repo to read commit $Commit from (pass -RepoRoot)."
        exit 2
    }
    $exists = Invoke-Git @('cat-file', '-e', "$Commit^{commit}")
    if ($exists.Code -ne 0) {
        Add-Failure "commit $Commit is not in $RepoRoot."
    } elseif ($evidenceSha -match '^[0-9a-f]{40}$') {
        $ancestor = Invoke-Git @('merge-base', '--is-ancestor', $evidenceSha, $Commit)
        if ($ancestor.Code -ne 0) {
            Add-Failure "commit $Commit does not contain the commit the gates ran on ($($evidenceSha.Substring(0, 12)))."
        } else {
            $changed = Invoke-Git @('diff', '--name-only', $evidenceSha, $Commit)
            $code = @($changed.Lines | Where-Object { $_.Trim() -and $_ -notmatch '^docs/releases/' })
            if ($code.Count -gt 0) { Add-Failure ("code changed after the gates ran ({0} file(s) outside docs/releases between {1} and {2}: {3})." -f $code.Count, $evidenceSha.Substring(0, 12), $Commit.Substring(0, [math]::Min(12, $Commit.Length)), (($code | Select-Object -First 4) -join ', ')) }
        }
    }
    $notes = $null
    foreach ($name in $notesNames) {
        $blob = Invoke-Git @('show', "${Commit}:docs/releases/$name")
        if ($blob.Code -eq 0) { $notes = ($blob.Lines -join "`n"); break }
    }
    if ($null -eq $notes) {
        Add-Failure "the release notes ($($notesNames -join ' or ')) are not in commit $Commit."
    } else {
        $marker = [regex]::Match($notes, '<!-- gate-evidence:begin sha=([0-9a-f]{40}) release=([0-9a-f]{12}) json-sha256=([0-9a-f]{64}) result=(PASS|FAIL) -->')
        if (-not $marker.Success) {
            Add-Failure "the notes at commit $Commit have no Gate evidence section (run gate-evidence.ps1 and commit the notes)."
        } else {
            if ($marker.Groups[1].Value -ne $evidenceSha) { Add-Failure "the notes record evidence for commit $($marker.Groups[1].Value.Substring(0, 12)), the evidence file is for $($evidenceSha.Substring(0, 12))." }
            if ($marker.Groups[2].Value -ne $Release) { Add-Failure "the notes record evidence for release $($marker.Groups[2].Value), not $Release." }
            $fileHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($marker.Groups[3].Value -ne $fileHash) { Add-Failure "the evidence file changed since the notes were written (notes sha256 $($marker.Groups[3].Value.Substring(0, 12)), file $($fileHash.Substring(0, 12))). Rerun gate-evidence.ps1 and commit the notes." }
            if ($marker.Groups[4].Value -ne 'PASS') { Add-Failure 'the notes record a FAIL result.' }
        }
    }
}

Finish
$names = ($gates | ForEach-Object { $_.id }) -join ', '
Write-Host ("PASS: gate evidence for release {0} ({1}) is good: commit {2}, tree clean, gates {3} all passed{4}." -f $Release, $Version, $evidenceSha.Substring(0, 12), $names, $(if ($Commit) { "; only docs/releases changed up to $($Commit.Substring(0, [math]::Min(12, $Commit.Length)))" } else { '' }))
exit 0
