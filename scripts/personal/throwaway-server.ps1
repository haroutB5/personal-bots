<#
.SYNOPSIS
Starts, pairs and stops a fresh-root throwaway hbots server for tests. One script for the whole team.

.DESCRIPTION
Start  (-Name <n> -Release <folder|worktree|sha12>): makes a fresh root %TEMP%\hbots-tw-<n>, writes
       userdata\settings.json so the Claude provider is a fake CLI (never a real account), sets
       PERSONAL_SEED_MODEL=claude-sonnet-5-5 (seeded bots must not start on Fable), picks a free port,
       starts the server from the release and prints the URL, a pairing link and the server PID.
       -Release is a release folder (dist\bin.mjs), a built worktree (apps\server\dist\bin.mjs) or a
       sha12 under ~\.personal-bots\releases.
Stop   (-Stop <n>): stops only the PID recorded in the root (after checking its command line still names
       that release and root), then deletes the root. Reparse points (junctions, symlinks) inside the
       root are unlinked and never followed. Nothing else is touched; nothing is killed by name.
Pair   (-Pair <n>): prints a fresh single-use pairing link for a running throwaway server.
List   (-List): the throwaway roots under %TEMP% and whether their server runs.

Two fake Claude CLIs are copied from scripts\personal\testing\fake-claude into <root>\fake:
  fakeok     the default Claude provider instance (claudeAgent): answers, usage reading "Session 10%".
  fakelimit  a second instance (claudeLimited, "Home (limited)"): the home provider that hits its limit
             while <root>\fake-pids\limit-until holds a future epoch in ms.
Trigger words and state files are documented at the top of testing\fake-claude\cli.js.

The server listens on 127.0.0.1 only. Dark mode and a 390 px viewport are the team's test default; this
script does not drive a browser.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\throwaway-server.ps1 -Name fb1651 -Release C:\Users\Ht\.personal-bots\releases\3c8940d78e26
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\throwaway-server.ps1 -Stop fb1651
#>
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    [Parameter(ParameterSetName = 'Start', Mandatory = $true)][string]$Name,
    [Parameter(ParameterSetName = 'Start', Mandatory = $true)][string]$Release,
    [Parameter(ParameterSetName = 'Start')][int]$Port = 0,
    [Parameter(ParameterSetName = 'Start')][int]$StartTimeoutSeconds = 300,
    [Parameter(ParameterSetName = 'Start')][string]$Node,
    [Parameter(ParameterSetName = 'Stop', Mandatory = $true)][string]$Stop,
    [Parameter(ParameterSetName = 'Pair', Mandatory = $true)][string]$Pair,
    [Parameter(ParameterSetName = 'List', Mandatory = $true)][switch]$List,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$RootPrefix = 'hbots-tw-'
$RecordName = 'throwaway.json'
$NamePattern = '^[a-z0-9][a-z0-9-]{0,30}$'

function Get-TwRoot {
    param([Parameter(Mandatory = $true)][string]$TwName)
    if ($TwName -notmatch $NamePattern) {
        throw "Name '$TwName' must be 1 to 31 characters: lower-case letters, digits and dashes, starting with a letter or digit."
    }
    return (Join-Path ([System.IO.Path]::GetTempPath().TrimEnd('\')) ($RootPrefix + $TwName))
}

function Read-TwRecord {
    param([Parameter(Mandatory = $true)][string]$Root)
    $file = Join-Path $Root $RecordName
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-TwText {
    param([string]$Path, [string]$Text)
    # UTF-8 without a BOM: the server's JSON reader refuses a BOM.
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function ConvertTo-ForwardSlash { param([string]$Path) return ($Path -replace '\\', '/') }

# A release folder, a built worktree, or a sha12 of a staged release.
function Resolve-TwBin {
    param([Parameter(Mandatory = $true)][string]$Where)
    $bases = @($Where)
    if ($Where -match '^[0-9a-f]{7,40}$') {
        $bases += (Join-Path (Get-PbPaths -Root dev).ReleasesDir $Where)
    }
    foreach ($base in $bases) {
        foreach ($relative in @('dist\bin.mjs', 'apps\server\dist\bin.mjs')) {
            $candidate = Join-Path $base $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }
    throw "No dist\bin.mjs or apps\server\dist\bin.mjs under '$Where'. Pass a release folder, a built worktree or a sha12."
}

# Unlinks every reparse point under $Path (never descending into one), then removes the tree.
function Remove-TwRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Path)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                if ($entry.PSIsContainer) { [System.IO.Directory]::Delete($entry.FullName) }
                else { [System.IO.File]::Delete($entry.FullName) }
            } elseif ($entry.PSIsContainer) {
                $stack.Push($entry.FullName)
            }
        }
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $env:ComSpec /d /s /c ('rmdir /s /q "' + $Path + '"') 2>&1 | Out-Null
    $ErrorActionPreference = $previous
    return (-not (Test-Path -LiteralPath $Path))
}

function Test-TwRunning {
    param($Record)
    if ($null -eq $Record) { return $false }
    return (Test-PbServerProcess -ProcessId ([int]$Record.pid) -BinPath ([string]$Record.bin) -BaseDir ([string]$Record.root))
}

function New-TwFakeClaude {
    param([string]$Root, [string]$NodeExe)
    $source = Join-Path $PSScriptRoot 'testing\fake-claude'
    foreach ($file in @('cli.js', 'package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
            throw "Missing $source\$file."
        }
    }
    foreach ($persona in @('fakeok', 'fakelimit')) {
        $dir = Join-Path $Root ('fake\' + $persona)
        $pkg = Join-Path $dir 'node_modules\@anthropic-ai\claude-code'
        New-Item -ItemType Directory -Force -Path $pkg | Out-Null
        Copy-Item -LiteralPath (Join-Path $source 'cli.js') -Destination (Join-Path $pkg 'cli.js')
        Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination (Join-Path $pkg 'package.json')
        # The folder name picks the persona; the absolute node path means PATH does not matter.
        Write-TwText -Path (Join-Path $dir 'claude.cmd') -Text ('@"' + $NodeExe + '" "%~dp0node_modules\@anthropic-ai\claude-code\cli.js" %*' + "`r`n")
    }
}

function Write-TwSettings {
    param([string]$Root)
    $ok = ConvertTo-ForwardSlash (Join-Path $Root 'fake\fakeok\claude.cmd')
    $limit = ConvertTo-ForwardSlash (Join-Path $Root 'fake\fakelimit\claude.cmd')
    $settings = [ordered]@{
        providers         = [ordered]@{
            claudeAgent = [ordered]@{ binaryPath = $ok }
            codex       = [ordered]@{ enabled = $false }
            opencode    = [ordered]@{ enabled = $false }
            cursor      = [ordered]@{ enabled = $false }
            grok        = [ordered]@{ enabled = $false }
        }
        providerInstances = [ordered]@{
            claudeLimited = [ordered]@{
                driver      = 'claudeAgent'
                displayName = 'Home (limited)'
                config      = [ordered]@{ binaryPath = $limit }
            }
        }
    }
    $dir = Join-Path $Root 'userdata'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-TwText -Path (Join-Path $dir 'settings.json') -Text ($settings | ConvertTo-Json -Depth 8)
}

# Prints the pairing link (a fresh single-use token) for a running throwaway server.
function New-TwPairingLink {
    param($Record, [string]$NodeExe)
    $origin = 'http://127.0.0.1:' + $Record.port
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = (& $NodeExe ([string]$Record.bin) pair --base-dir ([string]$Record.root) 2>&1 | Out-String)
    $ErrorActionPreference = $previous
    $token = [regex]::Match($text, '(?m)^\s*Token:\s*(\S+)')
    if ($token.Success) { return ($origin + '/pair#token=' + $token.Groups[1].Value) }
    throw ('Could not mint a pairing link: ' + $text.Trim().Substring(0, [Math]::Min(300, $text.Trim().Length)))
}

function Show-Result {
    param([System.Collections.IDictionary]$Info)
    if ($Json) {
        [pscustomobject]$Info | ConvertTo-Json -Compress
        return
    }
    foreach ($key in $Info.Keys) { Write-Output ('{0,-9} {1}' -f ($key + ':'), $Info[$key]) }
}

# ---------------------------------------------------------------- List
if ($List) {
    $temp = [System.IO.Path]::GetTempPath().TrimEnd('\')
    $rows = @()
    foreach ($dir in @(Get-ChildItem -LiteralPath $temp -Directory -Filter ($RootPrefix + '*') -ErrorAction SilentlyContinue)) {
        $record = Read-TwRecord -Root $dir.FullName
        $rows += [pscustomobject]@{
            Name    = $dir.Name.Substring($RootPrefix.Length)
            Root    = $dir.FullName
            Port    = if ($record) { $record.port } else { $null }
            Pid     = if ($record) { $record.pid } else { $null }
            Running = (Test-TwRunning -Record $record)
        }
    }
    if ($Json) { ConvertTo-Json -InputObject @($rows) -Compress } else { $rows | Format-Table -AutoSize | Out-String | Write-Output }
    exit 0
}

# ---------------------------------------------------------------- Stop
if ($PSCmdlet.ParameterSetName -eq 'Stop') {
    $root = Get-TwRoot -TwName $Stop
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        Write-Output "No throwaway root for '$Stop' ($root). Nothing to do."
        exit 0
    }
    $record = Read-TwRecord -Root $root
    $stopped = 'no recorded server'
    if ($record) {
        if (Test-TwRunning -Record $record) {
            if (-not (Stop-PbProcessTree -ProcessId ([int]$record.pid))) {
                Write-Error "PID $($record.pid) is still alive after taskkill. The root was NOT deleted."
                exit 1
            }
            $stopped = "stopped PID $($record.pid)"
        } else {
            # Dead, or the PID now belongs to something else: never kill it.
            $stopped = "PID $($record.pid) was not this server any more (left alone)"
        }
        $listening = @(Get-NetTCPConnection -LocalPort ([int]$record.port) -State Listen -ErrorAction SilentlyContinue)
        if ($listening.Count -gt 0) {
            Write-Warning "Port $($record.port) still has a listener (PID $($listening[0].OwningProcess)); it is not ours to kill. The root is deleted anyway."
        }
    }
    if (-not (Remove-TwRoot -Path $root)) {
        Write-Error "Could not delete $root completely."
        exit 1
    }
    Write-Output "Stopped '$Stop': $stopped; deleted $root."
    exit 0
}

# ---------------------------------------------------------------- Pair
if ($PSCmdlet.ParameterSetName -eq 'Pair') {
    $root = Get-TwRoot -TwName $Pair
    $record = Read-TwRecord -Root $root
    if (-not (Test-TwRunning -Record $record)) { throw "'$Pair' is not running. Start it with -Name $Pair -Release <release>." }
    Show-Result @{ Pairing = (New-TwPairingLink -Record $record -NodeExe (Resolve-NodeExe -Node $Node)) }
    exit 0
}

# ---------------------------------------------------------------- Start
$root = Get-TwRoot -TwName $Name
if (Test-Path -LiteralPath $root) {
    throw "$root already exists. Run -Stop $Name first: every throwaway server starts on a fresh root."
}
$nodeExe = Resolve-NodeExe -Node $Node
$bin = Resolve-TwBin -Where $Release
if ($Port -le 0) { $Port = Get-FreeTcpPort }
$origin = 'http://127.0.0.1:' + $Port

New-Item -ItemType Directory -Force -Path $root | Out-Null
$pidDir = Join-Path $root 'fake-pids'
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null
New-TwFakeClaude -Root $root -NodeExe $nodeExe
Write-TwSettings -Root $root

Clear-DevOriginEnv
$envSet = [ordered]@{
    PERSONAL_SEED_MODEL               = 'claude-sonnet-5-5'
    FAKE_CLAUDE_PID_DIR               = $pidDir
    T3CODE_PERSONAL_BROWSER_HEADLESS  = '1'
    T3CODE_AUTO_CONNECT               = 'false'
    T3CODE_ENVIRONMENT_LABEL          = ('throwaway ' + $Name)
}
$previousEnv = @{}
foreach ($key in $envSet.Keys) {
    $previousEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, [string]$envSet[$key], 'Process')
}
$proc = $null
try {
    $argList = @('"' + $bin + '"', 'serve', '--base-dir', '"' + $root + '"', '--host', '127.0.0.1', '--no-browser', '--port', [string]$Port)
    $proc = Start-Process -FilePath $nodeExe -ArgumentList ($argList -join ' ') -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server.err.log') -PassThru
    $null = $proc.Handle
} finally {
    foreach ($key in $envSet.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previousEnv[$key], 'Process')
    }
}

$record = [ordered]@{
    name      = $Name
    root      = $root
    port      = $Port
    pid       = $proc.Id
    bin       = $bin
    node      = $nodeExe
    startedAt = (Get-Date).ToString('o')
}
Write-TwText -Path (Join-Path $root $RecordName) -Text ($record | ConvertTo-Json)

$up = $false
$deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    try {
        $response = Invoke-WebRequest -Uri ($origin + '/version.txt') -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $up = $true; break }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $up) {
    $tail = ''
    foreach ($log in @('server.err.log', 'server.log')) {
        $path = Join-Path $root $log
        if (Test-Path -LiteralPath $path) { $tail += (Get-Content -LiteralPath $path -Tail 8 -ErrorAction SilentlyContinue | Out-String) }
    }
    if (-not $proc.HasExited) { $null = Stop-PbProcessTree -ProcessId $proc.Id }
    $null = Remove-TwRoot -Path $root
    throw ("The server did not come up on $origin" + $(if ($proc.HasExited) { " (it exited with code $($proc.ExitCode))" } else { " within $StartTimeoutSeconds s" }) + ". Root removed. Last log lines:`n" + $tail)
}

try {
    $link = New-TwPairingLink -Record ([pscustomobject]$record) -NodeExe $nodeExe
} catch {
    $link = 'unavailable: run -Pair ' + $Name + ' (' + $_.Exception.Message.Split("`n")[0] + ')'
}
Show-Result ([ordered]@{
        Name    = $Name
        Root    = $root
        URL     = $origin
        Pairing = $link
        PID     = $proc.Id
        Version = ((Invoke-WebRequest -Uri ($origin + '/version.txt') -UseBasicParsing -TimeoutSec 5).Content.Trim())
        Stop    = ('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\throwaway-server.ps1 -Stop ' + $Name)
    })
