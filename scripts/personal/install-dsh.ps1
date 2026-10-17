<#
.SYNOPSIS
Installs the pinned DeepSeek Harness (dsh) runtime once per machine, outside every release folder.

.DESCRIPTION
Copies scripts\personal\dsh-runtime\{package.json,package-lock.json,hbots-deny-plugin.mjs} into
%USERPROFILE%\.personal-bots\runtimes\dsh-<Version>\ and installs it with
`npm ci --ignore-scripts --no-audit --no-fund` from the committed lockfile. Then it runs
`node <dir>\node_modules\@deepseek-ai\dsh\lib\bin.js --version` and refuses unless that prints the pin.

Never inside a release folder: the tree is about 509 MB with native addons, and hbots releases are
retained and never pruned. Idempotent: a version that already answers its own `--version` is skipped.

Parameters:
  -Version  the pinned dsh version (default 0.2.1-rc.2)
  -Node     path to node.exe (default: Program Files\nodejs\node.exe, else the vite-plus runtime)
  -Force    reinstall even when the pin already answers

Exit codes: 0 installed or already present, 1 a failure (message on stderr).
#>
[CmdletBinding()]
param(
    [string]$Version = '0.2.1-rc.2',
    [string]$Node,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$runtimeDir = Join-Path (Join-Path $PbHome 'runtimes') ("dsh-{0}" -f $Version)
$sourceDir = Join-Path $PSScriptRoot 'dsh-runtime'
$binJs = Join-Path $runtimeDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'

function Get-DshVersion {
    param([string]$NodeExe, [string]$BinJs)
    if (-not (Test-Path -LiteralPath $BinJs -PathType Leaf)) { return $null }
    try {
        $output = & $NodeExe $BinJs '--version' 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        return ([string]($output | Select-Object -First 1)).Trim()
    } catch {
        return $null
    }
}

$nodeExe = Resolve-NodeExe -Node $Node
$pin = $Version

if (-not $Force) {
    $installed = Get-DshVersion -NodeExe $nodeExe -BinJs $binJs
    if ($installed -eq $pin) {
        Write-Host "dsh $pin already installed at $runtimeDir"
        exit 0
    }
    if ($installed) {
        Write-Host "dsh at $runtimeDir answers '$installed', not the pin '$pin'. Reinstalling."
    }
}

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Missing $sourceDir (the committed package.json, package-lock.json and deny plugin)."
}
foreach ($file in @('package.json', 'package-lock.json', 'hbots-deny-plugin.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $file) -PathType Leaf)) {
        throw "Missing $sourceDir\$file."
    }
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
foreach ($file in @('package.json', 'package-lock.json', 'hbots-deny-plugin.mjs')) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $file) -Destination (Join-Path $runtimeDir $file) -Force
}

$npm = (Get-Command npm -ErrorAction SilentlyContinue)
if (-not $npm) {
    throw "npm not found on PATH. Install Node 24 (which ships npm) and run this again."
}

Write-Host "Installing dsh $pin into $runtimeDir (npm ci --ignore-scripts, this takes about 5 minutes)..."
$previousLocation = Get-Location
try {
    Set-Location -LiteralPath $runtimeDir
    # npm ci is the only install path: it deletes node_modules and installs exactly
    # the committed lockfile. --ignore-scripts is safe here because every native
    # addon this runtime needs ships a prebuilt win32-x64 binary in its tarball.
    & $npm.Source 'ci' '--ignore-scripts' '--no-audit' '--no-fund'
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed in $runtimeDir (exit $LASTEXITCODE)."
    }
} finally {
    Set-Location -LiteralPath $previousLocation
}

$installed = Get-DshVersion -NodeExe $nodeExe -BinJs $binJs
if ($installed -ne $pin) {
    throw "Installed dsh answers '$installed', expected '$pin'. Nothing was activated: check the lockfile, then run this again."
}

Write-Host "dsh $pin ready at $runtimeDir (bin: $binJs)"
exit 0
