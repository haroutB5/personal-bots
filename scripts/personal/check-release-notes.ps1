<#
.SYNOPSIS
Fails when a release's notes (docs\releases\HANDOFF-<ver>.md) are missing, nearly empty or still hold a placeholder.

.DESCRIPTION
Run by the release waiter BEFORE `restart.ps1 -Release <new sha>` goes live, never on a rollback and never at
staging time: the builder stages first and the proof is written after QA, so a staged build needs no finished notes
(build.ps1 does not call this). restart.ps1 does not call it either, so `restart.ps1 -Release <older sha>` (the
rollback) can never be held up by a notes file. A waiter that rolls back simply does not run this step.

The notes file is found by version: 1.66.1 -> HANDOFF-1661.md (digits joined; for x.y.0 the older short form
HANDOFF-xy.md is accepted too). It is read from the working tree, or from a commit with -Commit (the waiter passes
the release's main sha so the check sees what was pushed, not whatever the checkout holds).

Placeholders it rejects (outside code blocks and `inline code`, so notes may still talk about them):
  any WORD_PLACEHOLDER or PLACEHOLDER, TODO, TBD, FIXME, XXX (upper case only), "to be filled/written/added/
  determined", "<fill in ...>" / "<insert ...>" markers, "lorem ipsum". A file under 200 characters is a stub.

Exit code: 0 notes are fine, 1 missing or placeholder found, 2 bad arguments or the commit cannot be read.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\check-release-notes.ps1 -Version 1.66.2
# in the waiter, from the pinned tools copy:
powershell -NoProfile -ExecutionPolicy Bypass -File "$pbRun\release-tools-1.66.2\check-release-notes.ps1" -Version 1.66.2 -Commit <main sha> -RepoRoot C:\Claude\AI\personal-bots
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    # Read docs\releases\HANDOFF-<ver>.md from this commit (git show) instead of the working tree.
    [string]$Commit,
    # Repo to read from. Default: the repo this script sits in; pass it when running from a release-tools copy.
    [string]$RepoRoot,
    # Test hook: check this file instead of looking one up by version.
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Host "FAIL: -Version must look like 1.66.2 (got '$Version')."
    exit 2
}
$major = $Matches[1]; $minor = $Matches[2]; $patch = $Matches[3]
$names = @("HANDOFF-$major$minor$patch.md")
if ($patch -eq '0') { $names += "HANDOFF-$major$minor.md" }

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue).Path }

$text = $null
$source = $null
if ($Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $text = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path)
        $source = $Path
    }
} elseif ($Commit) {
    if (-not $RepoRoot -or -not (Test-Path -LiteralPath $RepoRoot)) {
        Write-Host "FAIL: no repo to read commit $Commit from (pass -RepoRoot)."
        exit 2
    }
    foreach ($name in $names) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $blob = @(& git -C $RepoRoot show "${Commit}:docs/releases/$name" 2>$null)
        $code = $LASTEXITCODE
        $ErrorActionPreference = $previous
        if ($code -eq 0) {
            $text = ($blob -join "`n")
            $source = "${Commit}:docs/releases/$name"
            break
        }
    }
} else {
    foreach ($name in $names) {
        $file = if ($RepoRoot) { Join-Path $RepoRoot "docs\releases\$name" } else { $null }
        if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) {
            $text = [System.IO.File]::ReadAllText($file)
            $source = $file
            break
        }
    }
}

if ($null -eq $text) {
    $where = if ($Path) { $Path } elseif ($Commit) { "commit $Commit" } else { "docs\releases of $RepoRoot" }
    Write-Host ("FAIL: release notes for {0} are missing ({1} not found in {2}). Write them before this release goes live." -f $Version, ($names -join ' or '), $where)
    exit 1
}

# Placeholders inside fenced blocks and `inline code` are examples, not unfinished text: blank them, keep line numbers.
$lines = $text -split "`r?`n"
$visible = New-Object System.Collections.Generic.List[string]
$inFence = $false
foreach ($line in $lines) {
    if ($line -match '^\s*(```|~~~)') {
        $inFence = -not $inFence
        $visible.Add('')
        continue
    }
    if ($inFence) { $visible.Add(''); continue }
    $visible.Add(([regex]::Replace($line, '`[^`]*`', ' ')))
}

$rules = @(
    @{ Label = 'PLACEHOLDER'; Pattern = '\b[A-Z][A-Z0-9_]*_PLACEHOLDER\b|\bPLACEHOLDER\b'; Options = 'None' },
    @{ Label = 'TODO'; Pattern = '\bTODO\b'; Options = 'None' },
    @{ Label = 'TBD'; Pattern = '\bTBD\b'; Options = 'None' },
    @{ Label = 'FIXME'; Pattern = '\bFIXME\b'; Options = 'None' },
    @{ Label = 'XXX'; Pattern = '\bXXX\b'; Options = 'None' },
    @{ Label = 'to be filled in'; Pattern = '\bto be (filled|written|added|determined|completed)\b'; Options = 'IgnoreCase' },
    @{ Label = 'fill-in marker'; Pattern = '<\s*(fill|insert|todo|tbd|placeholder)[^>]*>'; Options = 'IgnoreCase' },
    @{ Label = 'lorem ipsum'; Pattern = 'lorem ipsum'; Options = 'IgnoreCase' }
)
$found = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $visible.Count; $i++) {
    foreach ($rule in $rules) {
        $options = [System.Text.RegularExpressions.RegexOptions]$rule.Options
        $match = [regex]::Match($visible[$i], $rule.Pattern, $options)
        if ($match.Success) { $found.Add(('line {0}: {1} ("{2}")' -f ($i + 1), $rule.Label, $match.Value)) }
    }
}

if ($found.Count -gt 0) {
    Write-Host ("FAIL: release notes for {0} still hold a placeholder in {1}:" -f $Version, $source)
    $found | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
    exit 1
}
if ($text.Trim().Length -lt 200) {
    Write-Host ("FAIL: release notes for {0} are a stub ({1} characters) in {2}." -f $Version, $text.Trim().Length, $source)
    exit 1
}
Write-Host ("PASS: release notes for {0} found and clean: {1} ({2} characters, no placeholder)." -f $Version, $source, $text.Trim().Length)
exit 0
