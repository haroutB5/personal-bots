<#
.SYNOPSIS
Removes the "Personal Bots" logon task. Leaves a running server alone
(stop it with stop.ps1).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\uninstall-task.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')

$existing = Get-ScheduledTask -TaskName $PbTaskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Write-Host "No '$PbTaskName' task is installed."
    exit 0
}

$ours = @($existing.Actions | Where-Object { $_.Arguments -and $_.Arguments -match 'scripts\\personal\\start\.ps1' })
if ($ours.Count -eq 0) {
    throw "The '$PbTaskName' task does not run scripts\personal\start.ps1. Refusing to remove it."
}

Unregister-ScheduledTask -TaskName $PbTaskName -Confirm:$false
Write-Host "Removed task '$PbTaskName'. A running server keeps running; stop it with stop.ps1."
