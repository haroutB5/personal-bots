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

Write-Host 'T3 Connect public config guard (build.ps1)'
$cfgNames = @($PbPublicConfigRequired + $PbPublicConfigOptional)
$cfgSaved = @{}
foreach ($name in $cfgNames) { $cfgSaved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$cfgTmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hbots-cfg-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $cfgTmp | Out-Null
try {
    foreach ($name in $PbPublicConfigRequired) { [Environment]::SetEnvironmentVariable($name, "test-value-$name", 'Process') }
    foreach ($name in $PbPublicConfigOptional) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }

    $cfgRefused = $false
    try { Assert-PbPublicBuildConfig } catch { $cfgRefused = $true }
    Assert-Equal 'both required keys set: the up-front guard passes' $false $cfgRefused

    [Environment]::SetEnvironmentVariable('T3CODE_CLERK_PUBLISHABLE_KEY', '   ', 'Process')
    $cfgMessage = ''
    try { Assert-PbPublicBuildConfig } catch { $cfgMessage = $_.Exception.Message }
    Assert-Equal 'a blank Clerk key refuses the build' $true ($cfgMessage -match 'T3CODE_CLERK_PUBLISHABLE_KEY')
    Assert-Equal 'the refusal names keys, never a value' $false ($cfgMessage -match 'test-value-')
    [Environment]::SetEnvironmentVariable('T3CODE_CLERK_PUBLISHABLE_KEY', 'test-value-T3CODE_CLERK_PUBLISHABLE_KEY', 'Process')

    $bin = Join-Path $cfgTmp 'bin.mjs'
    $good = 'const relay="test-value-T3CODE_RELAY_URL";const clerk="test-value-T3CODE_CLERK_PUBLISHABLE_KEY";'
    [System.IO.File]::WriteAllText($bin, $good)
    Assert-Equal 'a bundle carrying both values passes' 0 (@(Get-PbMissingBakedPublicConfig -BinPath $bin)).Count

    [System.IO.File]::WriteAllText($bin, 'const nothing="";')
    Assert-Equal 'a bundle without them names both keys' 'T3CODE_RELAY_URL,T3CODE_CLERK_PUBLISHABLE_KEY' `
        ((Get-PbMissingBakedPublicConfig -BinPath $bin) -join ',')

    [Environment]::SetEnvironmentVariable('T3CODE_CLERK_CLI_OAUTH_CLIENT_ID', 'test-value-oauth', 'Process')
    [System.IO.File]::WriteAllText($bin, $good)
    Assert-Equal 'a set optional key missing from the bundle is reported too' 'T3CODE_CLERK_CLI_OAUTH_CLIENT_ID' `
        ((Get-PbMissingBakedPublicConfig -BinPath $bin) -join ',')

    [System.IO.File]::WriteAllText($bin, $good + 'const oauth="test-value-oauth";')
    Assert-Equal 'a fully baked bundle passes' 0 (@(Get-PbMissingBakedPublicConfig -BinPath $bin)).Count
} finally {
    foreach ($name in $cfgNames) { [Environment]::SetEnvironmentVariable($name, $cfgSaved[$name], 'Process') }
    Remove-Item -LiteralPath $cfgTmp -Recurse -Force -ErrorAction SilentlyContinue
}
$cfgGuard = $buildText.IndexOf('Assert-PbPublicBuildConfig')
$cfgLoad = $buildText.IndexOf('Import-RepoDotEnv')
$cfgBuild = $buildText.IndexOf("Invoke-PbNative -FilePath 'vp'")
$cfgBaked = $buildText.IndexOf('Get-PbMissingBakedPublicConfig')
$cfgStage = $buildText.IndexOf('Copy-Item -LiteralPath $dist -Destination $releaseDist')
Assert-Equal 'build.ps1 checks the loaded env before it builds' $true ($cfgLoad -ge 0 -and $cfgGuard -gt $cfgLoad -and $cfgBuild -gt $cfgGuard)
Assert-Equal 'build.ps1 checks the bundle before staging it' $true ($cfgBaked -gt $cfgBuild -and $cfgStage -gt $cfgBaked)

Write-Host 'scheduler switch (T3CODE_PERSONAL_SCHEDULERS): restored copies off, live start never'
$schedEnv = 'T3CODE_PERSONAL_SCHEDULERS'
$schedBefore = [Environment]::GetEnvironmentVariable($schedEnv, 'Process')
try {
    [Environment]::SetEnvironmentVariable($schedEnv, 'off', 'Process')
    Clear-DevOriginEnv
    Assert-Equal 'Clear-DevOriginEnv clears an inherited switch' $null ([Environment]::GetEnvironmentVariable($schedEnv, 'Process'))
} finally {
    [Environment]::SetEnvironmentVariable($schedEnv, $schedBefore, 'Process')
}
$schedSet = '\$env:T3CODE_PERSONAL_SCHEDULERS\s*=|SetEnvironmentVariable\(\s*[''"]T3CODE_PERSONAL_SCHEDULERS'
$restoreText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'restore-test.ps1') -Raw
Assert-Equal 'restore-test.ps1 sets it off after Clear-DevOriginEnv and before the server starts' $true `
    ($restoreText -match "(?s)\nClear-DevOriginEnv\r?\n.*\n\`$env:T3CODE_PERSONAL_SCHEDULERS = 'off'\r?\n.*Start-PbServeProcess")
Assert-Equal 'restore-test.ps1 sets it exactly once' 1 ([regex]::Matches($restoreText, $schedSet)).Count
$startText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start.ps1') -Raw
Assert-Equal 'start.ps1 clears the launcher env before it starts the server' $true ($startText -match '(?s)\nClear-DevOriginEnv\r?\n.*Start-PbServeProcess')
foreach ($live in @('start.ps1', 'restart.ps1', 'install-task.ps1', 'stop.ps1', 'smoke.ps1')) {
    $liveText = Get-Content -LiteralPath (Join-Path $PSScriptRoot $live) -Raw
    Assert-Equal "$live (live path) never names the switch" $false ($liveText -match $schedEnv)
}
foreach ($rehearsal in @('updates\nightly-pipeline.ps1', 'upstream-sync.ps1')) {
    $rehearsalText = Get-Content -LiteralPath (Join-Path $PSScriptRoot $rehearsal) -Raw
    Assert-Equal "$rehearsal boots its rehearsal through restore-test.ps1" $true ($rehearsalText -match "-Name 'restore-test\.ps1'")
    Assert-Equal "$rehearsal never sets the switch in its own (live-restarting) process" 0 ([regex]::Matches($rehearsalText, $schedSet)).Count
}
$twText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'throwaway-server.ps1') -Raw
Assert-Equal 'throwaway-server.ps1 sets it only behind -SchedulersOff' 1 ([regex]::Matches($twText, "if \(\`$NoSchedulers\) \{ \`$envSet\['T3CODE_PERSONAL_SCHEDULERS'\] = 'off' \}")).Count

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
