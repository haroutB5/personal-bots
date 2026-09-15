<#
.SYNOPSIS
Builds the Personal Bots server with the web client bundled and stages it as a
versioned release under %USERPROFILE%\.personal-bots\releases\<sha>.

.DESCRIPTION
1. Loads the public T3 Connect config from the repo-root .env into this process
   (values are never printed). The build bakes it into the bundle.
2. Runs the upstream full build: vp run --filter t3 build
   (web build, then apps/server "node scripts/cli.ts build", which bundles the
   server and copies apps/web/dist into apps/server/dist/client).
3. Copies apps/server/dist into releases\<sha>\dist and links
   releases\<sha>\node_modules (a junction) to the checkout's
   apps\server\node_modules for the few native packages the bundle keeps
   external (node-pty, msgpackr-extract, ...).
   -CopyExternals copies that external closure into releases\<sha>\node_modules
   instead (copy-externals.mjs, ~20-60 MB), so the release survives a later
   `vp i` or the building checkout going away. The weekly upstream sync always
   uses it: auto-rollback is only trustworthy when each release carries its own
   externals.
4. Writes releases\<sha>\VERSION and makes it the active release
   (releases\current.txt) unless -NoActivate is given.

Touches no data root. The running server keeps using its own release until
restart.ps1.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\build.ps1
#>
[CmdletBinding()]
param(
    [string]$Node,
    [switch]$SkipBuild,
    [switch]$NoActivate,
    [switch]$CopyExternals
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
$nodeExe = Resolve-NodeExe -Node $Node
# Repo-local Node shim first: Smart App Control blocks the global vp.exe
# per-hash after vite-plus self-updates (seen 2026-09-14), the .CMD shim
# runs through node and is immune.
$vpRepoBin = Join-Path $PbRepoRoot 'node_modules\.bin'
$vpBin = Join-Path $env:LOCALAPPDATA 'vite-plus\bin'
$env:PATH = "$vpRepoBin;$vpBin;$(Split-Path -Parent $nodeExe);$env:PATH"

$keyCount = Import-RepoDotEnv
Clear-DevOriginEnv
Write-Host "Loaded $keyCount key(s) from .env (values not shown)."

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$sha = [string](& git -C $PbRepoRoot rev-parse --short=12 HEAD)
$branch = [string](& git -C $PbRepoRoot rev-parse --abbrev-ref HEAD)
$dirtyLines = @(& git -C $PbRepoRoot status --porcelain --untracked-files=no)
$ErrorActionPreference = $previous
$sha = $sha.Trim()
$branch = $branch.Trim()
if (-not $sha) { throw "Could not read the git commit of $PbRepoRoot." }
$dirty = $dirtyLines.Count -gt 0
$releaseName = $sha
if ($dirty) {
    # Uncommitted builds never overwrite the clean release of the same commit.
    $releaseName = '{0}-dirty-{1}' -f $sha, (Get-Date -Format 'yyyyMMddHHmmss')
    Write-Warning "Working tree has uncommitted changes; staging as $releaseName."
}

if (-not $SkipBuild) {
    Write-Host 'Building web client and server (vp run --filter t3 build)...'
    Invoke-PbNative -FilePath 'vp' -Arguments @('run', '--filter', 't3', 'build') -WorkingDirectory $PbRepoRoot
}

$dist = Join-Path $PbRepoRoot 'apps\server\dist'
# claude-history-worker.mjs: ClaudeAdapter's rollback/fork path spawns it.
foreach ($required in @('bin.mjs', 'client\index.html', 'claude-history-worker.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $required) -PathType Leaf)) {
        throw "Build output is missing apps\server\dist\$required."
    }
}

$releaseDir = Join-Path $paths.ReleasesDir $releaseName
$releaseDist = Join-Path $releaseDir 'dist'
$running = Read-PbServerState -Paths $paths
if ($running -and $running.release -eq $releaseName -and
    (Test-PbServerProcess -ProcessId ([int]$running.pid) -BinPath $running.binPath -BaseDir $running.baseDir)) {
    throw "Release $releaseName is the one currently running (pid $($running.pid)). Stop it first or build a new commit."
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
if (Test-Path -LiteralPath $releaseDist) {
    # dist holds only copied files; the node_modules junction sits beside it
    # and is never inside the tree being removed.
    Remove-Item -LiteralPath $releaseDist -Recurse -Force
}
Copy-Item -LiteralPath $dist -Destination $releaseDist -Recurse

$releaseModules = Join-Path $releaseDir 'node_modules'
$serverModules = Join-Path $PbRepoRoot 'apps\server\node_modules'
$modulesItem = Get-Item -LiteralPath $releaseModules -Force -ErrorAction SilentlyContinue
$modulesIsLink = $modulesItem -and (($modulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
if ($CopyExternals) {
    if ($modulesIsLink) {
        # Removes the junction itself; never recurse through it into the checkout.
        [System.IO.Directory]::Delete($releaseModules)
    } elseif ($modulesItem) {
        # A real directory from an earlier -CopyExternals build of this commit.
        Remove-Item -LiteralPath $releaseModules -Recurse -Force
    }
    Write-Host 'Copying runtime externals into the release...'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $copyOutput = & $nodeExe --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'copy-externals.mjs') `
        (Join-Path $PbRepoRoot 'apps\server') $releaseModules
    $copyCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $copyOutput | ForEach-Object { Write-Host "  $_" }
    if ($copyCode -ne 0) { throw "copy-externals.mjs failed (exit $copyCode)." }
    $externalsMode = 'copied'
} else {
    if (-not $modulesItem) {
        New-Item -ItemType Junction -Path $releaseModules -Target $serverModules | Out-Null
        $externalsMode = 'junction'
    } elseif ($modulesIsLink) {
        $externalsMode = 'junction'
    } else {
        $externalsMode = 'copied'
    }
}

# Smoke check: the externals resolve from the release, and the CLI loads.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$env:PB_RELEASE_BIN = Join-Path $releaseDist 'bin.mjs'
& $nodeExe -e "const r=require('node:module').createRequire(process.env.PB_RELEASE_BIN);r.resolve('node-pty');r.resolve('playwright-core')" | Out-Null
$resolveCode = $LASTEXITCODE
$cliVersion = [string](& $nodeExe (Join-Path $releaseDist 'bin.mjs') --version)
$versionCode = $LASTEXITCODE
$nodeVersion = [string](& $nodeExe --version)
$ErrorActionPreference = $previous
if ($resolveCode -ne 0) { throw "node-pty or playwright-core does not resolve from $releaseDir. Check releases\$releaseName\node_modules." }

# The upstream T3 Code commit this build is synced through (merge-base with
# upstream/main), when the checkout has the upstream remote.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$upstreamBase = [string](& git -C $PbRepoRoot merge-base HEAD upstream/main 2>$null)
$ErrorActionPreference = $previous
$upstreamBase = $upstreamBase.Trim()
if ($upstreamBase.Length -gt 12) { $upstreamBase = $upstreamBase.Substring(0, 12) }
if ($versionCode -ne 0) { throw "The staged CLI failed to start (t3 --version exited $versionCode)." }

$builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
# Human app version, bumped by hand in scripts/personal/app-version.txt per shipped change.
$appVersionFile = Join-Path $PSScriptRoot 'app-version.txt'
$appVersion = if (Test-Path $appVersionFile) { (Get-Content -LiteralPath $appVersionFile -First 1).Trim() } else { '' }
$version = @(
    "version=$appVersion",
    "release=$releaseName",
    "sha=$sha",
    "branch=$branch",
    "dirty=$dirty",
    "builtAt=$builtAt",
    "cli=$($cliVersion.Trim())",
    "node=$($nodeVersion.Trim())",
    "upstream=$upstreamBase",
    "externals=$externalsMode",
    "repo=$PbRepoRoot"
)
Set-Content -LiteralPath (Join-Path $releaseDir 'VERSION') -Value $version -Encoding ASCII
# The web app fetches /version.txt to show the build on the Chats screen and
# to detect a stale cached bundle: `client=` names the entry script of THIS
# build, and the app compares it with the script it is actually running.
# (Needs a file extension: the static handler treats extension-less paths as directories.)
$indexHtml = Get-Content -LiteralPath (Join-Path $releaseDist 'client\index.html') -Raw
$clientEntry = if ($indexHtml -match '/assets/(index-[A-Za-z0-9_-]+\.js)') { $Matches[1] } else { '' }
Set-Content -LiteralPath (Join-Path $releaseDist 'client\version.txt') -Value ($version + @("client=$clientEntry")) -Encoding ASCII

if (-not $NoActivate) {
    Set-Content -LiteralPath $paths.CurrentFile -Value $releaseName -Encoding ASCII
}

Write-Host ''
Write-Host "Release staged: $releaseDir"
Write-Host "  $($cliVersion.Trim()), $branch@$sha, built $builtAt"
if ($NoActivate) {
    Write-Host "  Not activated. Activate with: restart.ps1 -Release $releaseName"
} else {
    Write-Host '  Active release updated. Apply it with: scripts\personal\restart.ps1'
}
