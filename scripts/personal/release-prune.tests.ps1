<#
.SYNOPSIS
Tests for Select-PbPrunableReleases, the decision half of release pruning.

.DESCRIPTION
The dangerous part of pruning is the choice, not the delete, so the choice is a
pure function over a directory listing and is tested here without touching a
filesystem. Run it directly; it exits non-zero on the first failure.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-prune.tests.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')

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

# Newest first: r8 ... r1.
$releases = @(1..8 | ForEach-Object {
        [pscustomobject]@{ Name = "r$_"; LastWriteTime = (Get-Date '2026-09-01').AddDays($_) }
    })

Write-Host 'Select-PbPrunableReleases'

Assert-Equal 'keeps the newest N and prunes the rest, newest first' `
    @('r3', 'r2', 'r1') `
    (Select-PbPrunableReleases -Releases $releases -Keep 5)

Assert-Equal 'never prunes a protected release, however old' `
    @('r3', 'r2') `
    (Select-PbPrunableReleases -Releases $releases -Keep 5 -Protect @('r1'))

# The real guard set: active release, running release and rollback target, all
# of them old enough to fall outside the newest N.
Assert-Equal 'keeps the active, running and rollback releases together' `
    @('r3') `
    (Select-PbPrunableReleases -Releases $releases -Keep 4 -Protect @('r1', 'r2', 'r4'))

Assert-Equal 'protection is case-insensitive, like the filesystem' `
    @('r3', 'r2') `
    (Select-PbPrunableReleases -Releases $releases -Keep 5 -Protect @('R1'))

Assert-Equal 'a protected release does not consume one of the N slots' `
    @('r2', 'r1') `
    (Select-PbPrunableReleases -Releases $releases -Keep 5 -Protect @('r3'))

Assert-Equal 'ignores blank and unknown protected names' `
    @('r3', 'r2', 'r1') `
    (Select-PbPrunableReleases -Releases $releases -Keep 5 -Protect @('', $null, 'not-a-release'))

Assert-Equal 'prunes nothing when there are fewer releases than the keep count' `
    @() `
    (Select-PbPrunableReleases -Releases @($releases[0], $releases[1]) -Keep 5)

Assert-Equal 'handles an empty releases directory' `
    @() `
    (Select-PbPrunableReleases -Releases @() -Keep 5)

# Keep 0 is not something the scripts pass, but it must still not delete the
# releases the guards named.
Assert-Equal 'keep 0 still honours protection' `
    @('r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r1') `
    (Select-PbPrunableReleases -Releases $releases -Keep 0 -Protect @('r2'))

if ($script:failures -gt 0) {
    Write-Host ''
    Write-Host "$($script:failures) failure(s)."
    exit 1
}
Write-Host ''
Write-Host 'All release-prune selection tests passed.'
