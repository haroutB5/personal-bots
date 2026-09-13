<#
.SYNOPSIS
Backs up a Personal Bots data root to %USERPROFILE%\.personal-bots\backups\<timestamp>.

.DESCRIPTION
state.sqlite is snapshotted with VACUUM INTO (consistent even while the server
runs) and integrity-checked. attachments\, browser-artifacts\, themes\,
settings.json, keybindings.json and environment-id are copied beside it, plus
any userdata\personal* directories. secrets\ is deliberately NOT copied: a
backup never carries credentials, and a restored copy cannot relink T3 Connect.
Keeps the newest 14 backups.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\backup.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    [int]$Keep = 14,
    [string]$Node
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root $Root
$database = Join-Path $paths.StateDir 'state.sqlite'
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
    throw "No database at $database."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $paths.BackupsDir $stamp
if (Test-Path -LiteralPath $target) { throw "$target already exists." }
New-Item -ItemType Directory -Force -Path $target | Out-Null

$nodeExe = Resolve-NodeExe -Node $Node
$env:PB_SNAPSHOT_SOURCE = $database
$env:PB_SNAPSHOT_TARGET = Join-Path $target 'state.sqlite'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $nodeExe --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'sqlite-snapshot.cjs')
$code = $LASTEXITCODE
$ErrorActionPreference = $previous
if ($code -ne 0) {
    throw "SQLite snapshot failed (exit $code). Partial backup left at $target for inspection."
}

$copied = @('state.sqlite')
$items = @('attachments', 'browser-artifacts', 'themes', 'settings.json', 'keybindings.json', 'environment-id')
$items += @(Get-ChildItem -LiteralPath $paths.StateDir -Directory -Filter 'personal*' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name })
foreach ($item in $items) {
    $sourcePath = Join-Path $paths.StateDir $item
    if (Test-Path -LiteralPath $sourcePath) {
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $target $item) -Recurse -Force
        $copied += $item
    }
}

$manifest = [ordered]@{
    root      = $Root
    source    = $paths.StateDir
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    items     = $copied
}
Set-Content -LiteralPath (Join-Path $target 'backup.json') -Value ($manifest | ConvertTo-Json) -Encoding ASCII

# Prune: only timestamp-named directories directly under backups\.
$backupsRoot = (Resolve-Path -LiteralPath $paths.BackupsDir).Path
Get-ChildItem -LiteralPath $backupsRoot -Directory |
    Where-Object { $_.Name -match '^\d{8}-\d{6}$' } |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object {
        if ($_.Parent.FullName.TrimEnd('\') -eq $backupsRoot.TrimEnd('\')) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
            Write-Host "Pruned old backup $($_.Name)"
        }
    }

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "Backup written: $target ($sizeMb MB; $($copied -join ', '))"
