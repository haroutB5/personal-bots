# One machine-wide heavy developer job. Nested build/gate invocations inherit
# HBOTS_HEAVY_JOB_HELD. Same mutex and state file as the dev-team wrapper.
[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true, ParameterSetName = 'Command')][string]$Command,
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')][string]$ScriptPath,
    [Parameter(ParameterSetName = 'Script')][System.Collections.IDictionary]$ScriptParameters = @{},
    [string]$WorkDir = (Get-Location).Path,
    [int]$WaitMinutes = 180,
    # Test hooks isolate lock tests from the real build queue.
    [string]$MutexName = 'Global\hbots-heavy-job',
    [string]$StateFile = (Join-Path $env:USERPROFILE '.personal-bots\run\heavy-job.json')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'background-priority.ps1')
$mutex = $null
$held = $false
try {
    if ($env:HBOTS_HEAVY_JOB_HELD -ne '1') {
        $mutex = New-Object System.Threading.Mutex($false, $MutexName)
        $deadline = (Get-Date).AddMinutes($WaitMinutes)
        $lastNote = [datetime]::MinValue
        while (-not $held) {
            try { $held = $mutex.WaitOne(1000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
            if ($held) { break }
            if ((Get-Date) -ge $deadline) { Write-Host "heavy-job: lock timeout ($WaitMinutes min)"; exit 75 }
            if (((Get-Date) - $lastNote).TotalSeconds -ge 60) {
                $holder = if (Test-Path -LiteralPath $StateFile) { Get-Content -LiteralPath $StateFile -Raw } else { '(unknown)' }
                Write-Host ("heavy-job: waiting: {0}" -f ($holder -replace '\s+', ' '))
                $lastNote = Get-Date
            }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StateFile) | Out-Null
        @{ label = $Label; pid = $PID; workDir = $WorkDir; startedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json -Compress | Set-Content -LiteralPath $StateFile -Encoding UTF8
    }
    # The lock cannot be disabled. HBOTS_LOW_PRIORITY=off only disables lowering.
    Enter-PbBackgroundPriority -Label $Label
    $env:HBOTS_HEAVY_JOB_HELD = '1'
    Set-Location -LiteralPath $WorkDir
    if ($PSCmdlet.ParameterSetName -eq 'Script') {
        # Serialize arguments rather than rebuilding a shell command: preserves
        # switches, arrays, spaces and literal quotes without executing them.
        $xml = [System.Management.Automation.PSSerializer]::Serialize(@{ path = $ScriptPath; args = $ScriptParameters })
        $encodedArgs = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($xml))
        $body = '$ErrorActionPreference = ''Stop''; $p = [System.Management.Automation.PSSerializer]::Deserialize([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(''' + $encodedArgs + '''))); $a = $p.args; & $p.path @a; exit $LASTEXITCODE'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
    } else {
        & cmd.exe /d /s /c $Command
    }
    $code = $LASTEXITCODE
    Write-Host "heavy-job: exit $code :: $Label"
    exit $code
} finally {
    if ($held) {
        Remove-Item -LiteralPath $StateFile -ErrorAction SilentlyContinue
        $mutex.ReleaseMutex()
    }
    if ($mutex) { $mutex.Dispose() }
}
