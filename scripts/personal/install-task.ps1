<#
.SYNOPSIS
Registers the "Personal Bots" Task Scheduler task: current user, at logon,
runs only while that user is logged on, no elevated privileges.

.DESCRIPTION
The task runs start.ps1 -Wait, which supervises the server (restarts a crashed
server 3 times, 1 minute apart). The task itself also restarts on failure
3 times, 1 minute apart. No admin rights are needed.

Only ever creates or updates the task named "Personal Bots", and refuses to
replace a task of that name that does not run scripts\personal\start.ps1.
T3 Code's own tasks and services are never touched.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\install-task.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'prod')][string]$Root = 'dev'
)

. (Join-Path $PSScriptRoot 'common.ps1')

$startScript = Join-Path $PSScriptRoot 'start.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$existing = Get-ScheduledTask -TaskName $PbTaskName -ErrorAction SilentlyContinue
if ($existing) {
    $ours = @($existing.Actions | Where-Object { $_.Arguments -and $_.Arguments -match 'scripts\\personal\\start\.ps1' })
    if ($ours.Count -eq 0) {
        throw "A task named '$PbTaskName' exists but does not run scripts\personal\start.ps1. Refusing to replace it."
    }
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Root {1} -Wait' -f $startScript, $Root
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$description = "Starts the Personal Bots server (root $Root) at logon for $user. Managed by scripts\personal\install-task.ps1 in $PbRepoRoot."
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description

Register-ScheduledTask -TaskName $PbTaskName -InputObject $task -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $PbTaskName
Write-Host "Registered task '$PbTaskName' for $user (root $Root), state $($registered.State)."
Write-Host "  Action: $powershell $arguments"
Write-Host '  It starts at your next logon. Start it now with: Start-ScheduledTask -TaskName "Personal Bots"'
