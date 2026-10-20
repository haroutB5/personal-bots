<#
.SYNOPSIS
Backs up a Personal Bots data root to %USERPROFILE%\.personal-bots\backups\<timestamp>.

.DESCRIPTION
state.sqlite is snapshotted with SQLite's online backup API (consistent even while the server
runs) and integrity-checked. attachments\, browser-artifacts\, themes\,
settings.json, keybindings.json and environment-id are copied beside it, plus
any userdata\personal* directories. secrets\ is deliberately NOT copied: a
backup never carries credentials, and a restored copy cannot relink T3 Connect.
Keeps the newest 3 backups (pre-* migration backups are never pruned).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\backup.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev',
    [ValidateRange(3, 2147483647)][int]$Keep = 3,
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
$backupsRoot = (Resolve-Path -LiteralPath $paths.BackupsDir).Path

# A failed or killed run removes only its own fresh folder (never a published one, never through
# a junction), so retention, which skips folders without backup.json, is never left a partial.
function Remove-FreshTarget {
    $item = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return }
    if ($item.Name -ne $stamp -or $item.Parent.FullName.TrimEnd('\') -ne $backupsRoot.TrimEnd('\')) { return }
    if (Test-Path -LiteralPath (Join-Path $target 'backup.json')) { return }
    # rmdir /s removes junctions inside without following them.
    & cmd.exe /d /c rmdir /s /q $target
    if (Test-Path -LiteralPath $target) { Write-Warning "Could not remove the partial backup $target." }
    else { Write-Host "Removed the partial backup $target." }
}

try {
    $nodeExe = Resolve-NodeExe -Node $Node
    $timings = [ordered]@{}
    $snapshotWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $env:PB_SNAPSHOT_SOURCE = $database
    $env:PB_SNAPSHOT_TARGET = Join-Path $target 'state.sqlite'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $nodeExe --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'sqlite-snapshot.cjs')
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $timings['snapshotAndValidationSeconds'] = [math]::Round($snapshotWatch.Elapsed.TotalSeconds, 3)
    Write-Host "Backup timing snapshot and validation: $($timings['snapshotAndValidationSeconds']) s"
    if ($code -ne 0) {
        throw "SQLite snapshot failed (exit $code)."
    }

    $copied = @('state.sqlite')
    $copyWatch = [System.Diagnostics.Stopwatch]::StartNew()
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

    $timings['fileCopySeconds'] = [math]::Round($copyWatch.Elapsed.TotalSeconds, 3)
    Write-Host "Backup timing file copy: $($timings['fileCopySeconds']) s"
    $manifest = [ordered]@{
        root      = $Root
        source    = $paths.StateDir
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        items     = $copied
        validation = Get-Content -LiteralPath (Join-Path $target 'state.sqlite.integrity.json') -Raw | ConvertFrom-Json
    }
    $manifestCandidate = Join-Path $target 'backup.json.pending'
    Set-Content -LiteralPath $manifestCandidate -Value ($manifest | ConvertTo-Json -Depth 6) -Encoding ASCII
    # An interrupted manifest write must never count as a verified retention slot.
    [System.IO.File]::Move($manifestCandidate, (Join-Path $target 'backup.json'))
} catch {
    Remove-FreshTarget
    throw
}

# Prune: only timestamp-named directories directly under backups\.
$pruneWatch = [System.Diagnostics.Stopwatch]::StartNew()
Get-ChildItem -LiteralPath $backupsRoot -Directory |
    Where-Object { $_.Name -match '^\d{8}-\d{6}$' -and
        -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'backup.json') -PathType Leaf) } |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object {
        if ($_.Parent.FullName.TrimEnd('\') -eq $backupsRoot.TrimEnd('\')) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
            Write-Host "Pruned old backup $($_.Name)"
        }
    }

$timings['pruningSeconds'] = [math]::Round($pruneWatch.Elapsed.TotalSeconds, 3)
Write-Host "Backup timing pruning: $($timings['pruningSeconds']) s"
$sizeWatch = [System.Diagnostics.Stopwatch]::StartNew()
$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
$timings['sizeScanSeconds'] = [math]::Round($sizeWatch.Elapsed.TotalSeconds, 3)
Set-Content -LiteralPath (Join-Path $target 'backup-timings.json') -Value ($timings | ConvertTo-Json) -Encoding ASCII
Write-Host "Backup written: $target ($sizeMb MB; $($copied -join ', '))"
