<#
.SYNOPSIS
Scripted 390 px dark check of the Usage sheet (1.66.1) on a throwaway server: the sheet keeps every number
through a slow probe, a probe that cannot read usage, the incident's timed-out CLI version check, and a
server restart.

.DESCRIPTION
Starts a fresh-root throwaway server (throwaway-server.ps1, fake Claude CLIs, never a real account), flips
the fake's flags between phases (see testing\fake-claude\cli.js: usage-weekly, usage-fail, version-hang),
runs usage-check.mjs per phase, restarts the server on the same root and port in the middle (only the
recorded PID's tree is stopped), and stops and deletes the throwaway at the end. Screenshots and the
transcript go to -Out. Exit 0 only when every phase passed.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e\usage-check.ps1 -Release 3c8940d78e26 -Out C:\Users\Ht\.personal-bots\qa\usage-1661
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Name = 'usage-check',
    [string]$Node
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$personal = Split-Path -Parent $here
. (Join-Path $personal 'common.ps1')
$nodeExe = Resolve-NodeExe -Node $Node
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$twScript = Join-Path $personal 'throwaway-server.ps1'
$failed = $false

function Invoke-Tw {
    param([string[]]$TwArgs)
    $text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $twScript @TwArgs
    if ($LASTEXITCODE -ne 0) { throw "throwaway-server.ps1 $($TwArgs -join ' ') exited $LASTEXITCODE" }
    return $text
}

function Set-FakeFlag {
    param([string]$PidDir, [string]$FlagName, [bool]$On)
    $file = Join-Path $PidDir $FlagName
    if ($On) { Set-Content -LiteralPath $file -Value '1' -Encoding ASCII }
    elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}

function Invoke-Phase {
    param([string]$Phase, [string[]]$Extra = @())
    Write-Host "== phase: $Phase"
    $phaseArgs = @((Join-Path $here 'usage-check.mjs'), '--origin', $script:info.URL, '--bin', $script:record.bin, '--out', $Out, '--phase', $Phase) + $Extra
    # Node's stderr must not become a PowerShell error record (the script runs with Stop).
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $nodeExe @phaseArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath (Join-Path $Out 'transcript.txt') -Append
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { $script:failed = $true; Write-Host "  phase $Phase FAILED (exit $code)" }
}

# A clean slate: an old root of this name is stopped and removed first (only its recorded PID).
$existing = Join-Path ([System.IO.Path]::GetTempPath().TrimEnd('\')) ("hbots-tw-$Name")
if (Test-Path -LiteralPath $existing) { Invoke-Tw @('-Stop', $Name) | Out-Null }
Remove-Item -LiteralPath (Join-Path $Out 'transcript.txt') -ErrorAction SilentlyContinue

$script:info = (Invoke-Tw @('-Name', $Name, '-Release', $Release, '-Json') | Out-String | ConvertFrom-Json)
$root = $script:info.Root
$recordFile = Join-Path $root 'throwaway.json'
$script:record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
$pidDir = Join-Path $root 'fake-pids'
Write-Host "throwaway $($script:info.URL) root $root release $($script:info.Version)"
try {
    # 1. both windows read fine
    Set-FakeFlag $pidDir 'usage-weekly' $true
    # The server's first probe ran before the flag existed: the seed phase asks for a fresh one with the refresh button.
    Invoke-Phase 'seed' @('--pair', $script:info.Pairing)

    # 2. a slow probe: numbers stay, "Refreshing" appears
    Set-FakeFlag $pidDir 'version-hang' $true
    Invoke-Phase 'refresh'

    # 3. the incident's failure (the CLI version check times out): numbers stay, "Couldn't refresh"
    Invoke-Phase 'failed' @('--expectFailure', 'yes', '--reason', 'failed to run', '--name', 'cli-timed-out')

    # 4. usage itself cannot be read
    Set-FakeFlag $pidDir 'version-hang' $false
    Set-FakeFlag $pidDir 'usage-fail' $true
    Invoke-Phase 'failed' @('--expectFailure', 'yes', '--name', 'usage-fail')

    # 5. restart with every probe failing: the persisted numbers are served at once
    Set-FakeFlag $pidDir 'version-hang' $true
    $old = $script:record
    Write-Host "== restart: stopping PID $($old.pid) (the recorded wrapper) and starting again on the same root and port"
    if (-not (Stop-PbProcessTree -ProcessId ([int]$old.pid))) { throw "could not stop PID $($old.pid)" }
    Start-Sleep -Seconds 2
    Clear-DevOriginEnv
    $envSet = [ordered]@{
        PERSONAL_SEED_MODEL              = 'claude-sonnet-5-5'
        FAKE_CLAUDE_PID_DIR              = $pidDir
        T3CODE_PERSONAL_BROWSER_HEADLESS = '1'
        T3CODE_AUTO_CONNECT              = 'false'
        T3CODE_ENVIRONMENT_LABEL         = ('throwaway ' + $Name)
    }
    $previous = @{}
    foreach ($key in $envSet.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$envSet[$key], 'Process')
    }
    try {
        $proc = Start-PbServeProcess -NodeExe $old.node -BinPath $old.bin -BaseDir $root -LogFile (Join-Path $root 'server-restarted.log') `
            -WorkingDirectory $root -Port ([int]$old.port) -HostName '127.0.0.1'
    } finally {
        foreach ($key in $envSet.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
    $new = [ordered]@{ name = $old.name; root = $old.root; port = $old.port; pid = $proc.Id; bin = $old.bin; node = $old.node; startedAt = (Get-Date).ToString('o') }
    [System.IO.File]::WriteAllText($recordFile, ($new | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    $deadline = (Get-Date).AddSeconds(120)
    $up = $false
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        try { if ((Invoke-WebRequest -Uri ($script:info.URL + '/version.txt') -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $up = $true; break } } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $up) { throw 'the restarted server did not come up' }
    $script:record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
    Write-Host '== restarted; the first probe is failing (CLI version check hangs)'
    Invoke-Phase 'restart' @('--expectFailure', 'yes')
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    $failed = $true
} finally {
    $stopText = Invoke-Tw @('-Stop', $Name)
    Write-Host ($stopText | Out-String).Trim()
}
if ($failed) { Write-Host 'FAILED'; exit 1 }
Write-Host 'All phases passed.'
exit 0
