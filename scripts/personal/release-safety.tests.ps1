<#
.SYNOPSIS
Tests for the release-safety scripts: build.ps1's stage-by-default rule and check-release-notes.ps1.

.DESCRIPTION
No server, no release and no data root is touched. Everything runs in a folder under %TEMP% that is deleted at the
end. Exits non-zero on any failure.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Assert-Equal {
    param([string]$What, $Expected, $Actual)
    if (($Expected -join ',') -eq ($Actual -join ',')) {
        Write-Host "  ok   $What"
    } else {
        Write-Host "  FAIL $What"
        Write-Host "       expected: [$($Expected -join ',')]"
        Write-Host "       actual:   [$($Actual -join ',')]"
        $script:failures++
    }
}

Write-Host 'build.ps1 activation rule (Resolve-PbBuildActivation)'
Assert-Equal 'no switch stages only' $false (Resolve-PbBuildActivation)
Assert-Equal '-NoActivate (old callers) stages only' $false (Resolve-PbBuildActivation -NoActivate)
Assert-Equal '-Activate activates' $true (Resolve-PbBuildActivation -Activate)
$refused = $false
try { [void](Resolve-PbBuildActivation -Activate -NoActivate) } catch { $refused = $true }
Assert-Equal '-Activate with -NoActivate is refused' $true $refused

Write-Host 'build.ps1 and restart.ps1 wiring'
$buildText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build.ps1') -Raw
Assert-Equal 'build.ps1 writes current.txt only behind $activateRelease' 1 ([regex]::Matches($buildText, 'Set-Content -LiteralPath \$paths\.CurrentFile')).Count
Assert-Equal 'the write sits in the -Activate branch' $true ($buildText -match '(?s)if \(\$activateRelease\) \{\s*Set-Content -LiteralPath \$paths\.CurrentFile')
Assert-Equal 'the closing message follows the real decision, not -NoActivate' $false ($buildText -match 'if \(\$NoActivate\)')
Assert-Equal 'build.ps1 still accepts -NoActivate' $true ($buildText -match '\[switch\]\$NoActivate')
$restartText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'restart.ps1') -Raw
Assert-Equal 'restart.ps1 (the rollback path) never calls the notes check' $false ($restartText -match 'check-release-notes')

Write-Host 'check-release-notes.ps1'
$check = Join-Path $PSScriptRoot 'check-release-notes.ps1'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hbots-relnotes-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'docs\releases') | Out-Null
$body = ('A real paragraph about what changed, how it was proven and what is left for the next release. ' * 4)
function Invoke-Check {
    param([string]$Text, [string]$Version = '9.9.9')
    $file = Join-Path $tmp 'docs\releases\HANDOFF-999.md'
    [System.IO.File]::WriteAllText($file, $Text)
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $check -Version $Version -RepoRoot $tmp 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out.Trim() }
}
try {
    $r = Invoke-Check ($body + "`n`nPROOF_PLACEHOLDER`n")
    Assert-Equal 'PROOF_PLACEHOLDER fails (exit 1)' 1 $r.Code
    Assert-Equal 'the message names the line and the token' $true ($r.Out -match 'line 3: PLACEHOLDER \("PROOF_PLACEHOLDER"\)')
    foreach ($token in @('TODO', 'TBD', 'FIXME', 'XXX')) {
        $r = Invoke-Check ($body + "`n`nProof: $token fill in later`n")
        Assert-Equal "$token fails" 1 $r.Code
    }
    $r = Invoke-Check ($body + "`n`nThe proof is to be written after QA.`n")
    Assert-Equal '"to be written" fails' 1 $r.Code
    $r = Invoke-Check ($body + "`n`n<insert proof here>`n")
    Assert-Equal '<insert ...> marker fails' 1 $r.Code
    $r = Invoke-Check 'Short.'
    Assert-Equal 'a stub fails' 1 $r.Code
    $r = Invoke-Check ($body + "`n`nPROOF_PLACEHOLDER`n") '9.9.8'
    Assert-Equal 'missing notes for another version fail (exit 1)' 1 $r.Code
    Assert-Equal 'the missing message says so' $true ($r.Out -match 'are missing')
    $r = Invoke-Check ($body + "`n`nGates: all exit 0. Release staged, 12 of 12 checks passed.`n")
    Assert-Equal 'a clean file passes (exit 0)' 0 $r.Code
    Assert-Equal 'the pass message names the file' $true ($r.Out -match '^PASS: ')
    $r = Invoke-Check ($body + "`n`nThe check rejects ``PROOF_PLACEHOLDER`` and ``TODO`` written in code spans.`n`n``````text`nTBD inside a fence`n```````n")
    Assert-Equal 'placeholders inside code spans and fences are only examples' 0 $r.Code
    $r = Invoke-Check ($body + "`n") 'abc'
    Assert-Equal 'a bad version is a usage error (exit 2)' 2 $r.Code
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
    Write-Host "$($script:failures) failure(s)."
    exit 1
}
Write-Host 'All passed.'
exit 0
