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
    [switch]$NoActivate
)

. (Join-Path $PSScriptRoot 'common.ps1')

$paths = Get-PbPaths -Root dev
$nodeExe = Resolve-NodeExe -Node $Node
$vpBin = Join-Path $env:LOCALAPPDATA 'vite-plus\bin'
$env:PATH = "$vpBin;$(Split-Path -Parent $nodeExe);$env:PATH"

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
foreach ($required in @('bin.mjs', 'client\index.html')) {
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
if (-not (Test-Path -LiteralPath $releaseModules)) {
    New-Item -ItemType Junction -Path $releaseModules -Target $serverModules | Out-Null
}

# Smoke check: the externals resolve from the release, and the CLI loads.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$env:PB_RELEASE_BIN = Join-Path $releaseDist 'bin.mjs'
& $nodeExe -e "require('node:module').createRequire(process.env.PB_RELEASE_BIN).resolve('node-pty')" | Out-Null
$resolveCode = $LASTEXITCODE
$cliVersion = [string](& $nodeExe (Join-Path $releaseDist 'bin.mjs') --version)
$versionCode = $LASTEXITCODE
$nodeVersion = [string](& $nodeExe --version)
$ErrorActionPreference = $previous
if ($resolveCode -ne 0) { throw "node-pty does not resolve from $releaseDir. Check the node_modules junction." }
if ($versionCode -ne 0) { throw "The staged CLI failed to start (t3 --version exited $versionCode)." }

$builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$version = @(
    "release=$releaseName",
    "sha=$sha",
    "branch=$branch",
    "dirty=$dirty",
    "builtAt=$builtAt",
    "cli=$($cliVersion.Trim())",
    "node=$($nodeVersion.Trim())",
    "repo=$PbRepoRoot"
)
Set-Content -LiteralPath (Join-Path $releaseDir 'VERSION') -Value $version -Encoding ASCII
# The web app fetches /VERSION to show the build on the Chats screen.
Set-Content -LiteralPath (Join-Path $releaseDist 'client\VERSION') -Value $version -Encoding ASCII

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
