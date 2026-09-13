<#
.SYNOPSIS
Mints a pairing link for the running Personal Bots server at its T3 Connect URL.

.DESCRIPTION
Runs: node <release>\dist\bin.mjs pair --connect --ttl <Ttl> --base-dir <root>
and prints https://<tunnel>/pair#token=... plus a QR code. The token is single use.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\pair.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    [string]$Ttl = '15m',
    [string]$Node
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root $Root
$state = Read-PbServerState -Paths $paths
$binPath = $null
if ($state -and $state.root -eq $Root) { $binPath = [string]$state.binPath }
if (-not $binPath) { $binPath = (Get-PbRelease -Paths $paths).Bin }
$nodeExe = Resolve-NodeExe -Node $Node
Clear-DevOriginEnv

$ErrorActionPreference = 'Continue'
& $nodeExe $binPath pair --connect --ttl $Ttl --base-dir $paths.BaseDir
exit $LASTEXITCODE
