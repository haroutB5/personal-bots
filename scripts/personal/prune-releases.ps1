<#
.SYNOPSIS
Deletes old staged releases under %USERPROFILE%\.personal-bots\releases.

.DESCRIPTION
Keeps the newest -Keep releases, plus every release that must survive whatever
its age: the active one (releases\current.txt), the one the recorded server
process is actually running (run\server.json), and any -Protect name, which is
how restart.ps1 hands in the rollback target.

Nothing had ever deleted a release, so they had grown to 62 directories and
7.6 GB. A junction inside a release (node_modules, pointing at the building
checkout on a build without -CopyExternals) is unlinked rather than followed.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\prune-releases.ps1 -DryRun

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\prune-releases.ps1
#>
[CmdletBinding()]
param(
    [int]$Keep = 5,
    [string[]]$Protect = @(),
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
Remove-PbOldReleases -Paths $paths -Keep $Keep -Protect $Protect -DryRun:$DryRun
