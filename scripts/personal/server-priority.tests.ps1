# Exercises the actual start.ps1 -Wait supervisor and smoke.ps1 with an isolated
# USERPROFILE and node/relay-shaped fixture. No scheduled task is changed.
param([string]$EvidenceDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('hbots-priority-test-' + [guid]::NewGuid().ToString('N'))
$homeDir = Join-Path $temp '.personal-bots'
$dist = Join-Path $homeDir 'releases\fixture\dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$nodeExe = Resolve-NodeExe
# A relay-shaped long-lived executable lets us prove inherited Windows process
# priorities without pairing a disposable server to the owner's T3 account.
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $dist 'cloudflared.exe')
[IO.File]::WriteAllText((Join-Path $dist 'bin.mjs'), @'
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path'; import { spawn } from 'node:child_process';
const args = process.argv.slice(2), base = args[args.indexOf('--base-dir')+1], port=Number(args[args.indexOf('--port')+1]);
const relay = spawn(path.join(import.meta.dirname,'cloudflared.exe'), ['-e','setInterval(()=>{},1000)'], {windowsHide:true,stdio:'ignore'});
const server = http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({serverVersion:'fixture'}));});
server.listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(base,'userdata'),{recursive:true});fs.writeFileSync(path.join(base,'userdata/server-runtime.json'),JSON.stringify({pid:process.pid,origin:'http://127.0.0.1:'+port,startedAt:new Date().toISOString()}));});
'@)
$port = Get-FreeTcpPort
$launch = Join-Path $temp 'launch.ps1'
$start = Join-Path $PSScriptRoot 'start.ps1'
[IO.File]::WriteAllText($launch, @"
`$env:USERPROFILE = '$($temp.Replace("'","''"))'
. '$($PSScriptRoot.Replace("'","''"))/background-priority.ps1'
`$null = Set-PbProcessPriority -ProcessId `$PID -Cpu BelowNormal -Io 1 -Memory 2
& '$($start.Replace("'","''"))' -Release fixture -Port $port -Wait
"@)
$supervisor = $null; $wrapperId = 0
$savedProfile = $env:USERPROFILE
try {
    $supervisor = Start-Process powershell.exe -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launch`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temp 'start.out') -RedirectStandardError (Join-Path $temp 'start.err')
    $null = $supervisor.Handle
    $statePath = Join-Path $homeDir 'run\server.json'
    for ($i=0;$i -lt 1800;$i++) {
        if (Test-Path $statePath) { $state = Get-Content $statePath -Raw | ConvertFrom-Json; $wrapperId = [int]$state.pid }
        if ((Get-Content (Join-Path $temp 'start.out') -Raw) -match 'Priority cloudflared.exe') { break }
        if ($supervisor.HasExited) { throw 'fixture supervisor exited early' }
        Start-Sleep -Milliseconds 100
    }
    $processes = @(Get-PbServerProcesses -RootProcessId $wrapperId)
    if ($processes.Count -ne 2) { throw 'fixture node and relay missing' }
    foreach ($p in $processes) {
        $text = Get-PbProcessPriorityText -ProcessId ([int]$p.ProcessId)
        Write-Host ("ok scheduled-style start: {0} {1}" -f $p.Name,$text)
        if ($text -notmatch 'cpu=AboveNormal io=2 mem=5$') { throw "Wrong priority: $text" }
    }
    $env:USERPROFILE = $temp
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'smoke.ps1') -ExpectRelease fixture -NoTunnel -StableSeconds 0 -StartTimeoutSeconds 2 > (Join-Path $temp 'smoke.out')
    if ($LASTEXITCODE -ne 0) { throw 'fixture smoke failed' }
    Write-Host 'ok smoke accepts AboveNormal/2/5'
    $null = Set-PbProcessPriority -ProcessId ([int]$processes[0].ProcessId) -Io 1 -Memory 2
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'smoke.ps1') -ExpectRelease fixture -NoTunnel -StableSeconds 0 -StartTimeoutSeconds 2 > (Join-Path $temp 'smoke-low.out')
    if ($LASTEXITCODE -ne 1) { throw 'smoke accepted low priority' }
    Write-Host 'ok smoke rejects low I/O and memory priority'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $start -Release fixture -Port $port > (Join-Path $temp 'existing.out')
    if ($LASTEXITCODE -ne 0) { throw 'existing-server start failed' }
    $text = Get-PbProcessPriorityText -ProcessId ([int]$processes[0].ProcessId)
    if ($text -notmatch 'cpu=AboveNormal io=2 mem=5$') { throw 'existing-server start did not restore priorities' }
    Write-Host 'ok idempotent start restores priority without restarting'
    Write-Host 'Tests: 5 passed'
} finally {
    $env:USERPROFILE = $savedProfile
    if (-not $wrapperId -and (Test-Path (Join-Path $homeDir 'run\server.json'))) {
        $wrapperId = [int](Get-Content (Join-Path $homeDir 'run\server.json') -Raw | ConvertFrom-Json).pid
    }
    if ($wrapperId) {
        New-Item -ItemType Directory -Force (Join-Path $homeDir 'run') | Out-Null
        Set-Content (Join-Path $homeDir 'run\stop-requested') stop
        $null = Stop-PbProcessTree -ProcessId $wrapperId
    }
    if ($supervisor -and -not $supervisor.WaitForExit(5000)) { Stop-Process -Id $supervisor.Id -Force }
    if ($EvidenceDir) {
        New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
        foreach ($file in @('start.out','start.err','smoke.out','smoke-low.out','existing.out')) {
            if (Test-Path (Join-Path $temp $file)) { Copy-Item (Join-Path $temp $file) (Join-Path $EvidenceDir $file) }
        }
    }
    $resolved = (Get-Item -LiteralPath $temp).FullName
    if ($resolved -notlike "$([IO.Path]::GetTempPath())hbots-priority-test-*") { throw 'Unsafe fixture cleanup' }
    if (@(Get-ChildItem -LiteralPath $temp -Recurse -Attributes ReparsePoint).Count -gt 0) { throw 'Unexpected fixture junction' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
