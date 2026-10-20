# Background process priority for our own heavy work (1.66.46). Dot-source only
# (common.ps1 does); defines functions, sets nothing at load. Windows PowerShell 5.1.
#
# The live server runs SQLite synchronously on its main thread, so a disk busy with our builds, gates, e2e
# runs, throwaway servers or perf runs froze it for seconds (stall reports and "sql NNN ms" lines, 10-14 Oct;
# a 16-row routines read took 12.6 s with 31 ms of CPU).
# - Enter-PbBackgroundPriority lowers the calling script's own process to CPU BelowNormal, I/O Very Low and
#   memory Very Low. Windows hands all three to every process it starts (checked 14 Oct: cmd.exe and its
#   node.exe grandchild came up BelowNormal, I/O 0, memory 1), so the whole tree runs in the background.
#   Called by build.ps1, gate-evidence.ps1, e2e-smoke.ps1, throwaway-server.ps1 and perf/check.mjs + bench.mjs;
#   never by start.ps1 or restart.ps1.
# - start/restart restore server and relay to AboveNormal, I/O 2, memory 5.
# Kill switch: HBOTS_LOW_PRIORITY=off (or 0, false, no, disabled) in the environment.
# The release runner's own backup priority (run/hbots-release/proc-priority.ps1) is separate and unchanged.

$PbLowPriorityEnvName = 'HBOTS_LOW_PRIORITY'

function Test-PbLowPriorityOn {
    $value = [Environment]::GetEnvironmentVariable($PbLowPriorityEnvName)
    if (-not $value) { return $true }
    return -not (@('off', '0', 'false', 'no', 'disabled') -contains $value.Trim().ToLowerInvariant())
}

# Compiled on first use only: most scripts that load common.ps1 never touch priorities.
function Initialize-PbProcPriorityType {
    if ('PbProcPriority' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PbProcPriority {
    [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref int info, int len, out int ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    const uint SET_INFO = 0x0200, QUERY_LIMITED = 0x1000;
    const int ProcessIoPriority = 33, ProcessPagePriority = 39;
    public static int SetIo(int pid, int level) { return Set(pid, ProcessIoPriority, level); }
    public static int SetMem(int pid, int level) { return Set(pid, ProcessPagePriority, level); }
    public static int GetIo(int pid) { return Get(pid, ProcessIoPriority); }
    public static int GetMem(int pid) { return Get(pid, ProcessPagePriority); }
    static int Set(int pid, int cls, int value) {
        IntPtr h = OpenProcess(SET_INFO, false, pid);
        if (h == IntPtr.Zero) return -1;
        try { return NtSetInformationProcess(h, cls, ref value, 4); } finally { CloseHandle(h); }
    }
    static int Get(int pid, int cls) {
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return -1;
        try { int v = -1; int ret; int st = NtQueryInformationProcess(h, cls, ref v, 4, out ret); return st == 0 ? v : -2; } finally { CloseHandle(h); }
    }
}
'@
}

# I/O priority: 0 very low, 1 low, 2 normal. Memory (page) priority: 1 very low, 2 low, 5 normal.
# Best-effort, never throws; returns one line for the log.
function Set-PbProcessPriority {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [string]$Cpu,
        [int]$Io = -1,
        [int]$Memory = -1
    )
    $parts = @()
    try {
        Initialize-PbProcPriorityType
        if ($Cpu) {
            try {
                $proc = Get-Process -Id $ProcessId -ErrorAction Stop
                if ([string]$proc.PriorityClass -ne $Cpu) { $proc.PriorityClass = $Cpu }
                $parts += "cpu=$Cpu"
            } catch { $parts += 'cpu=failed' }
        }
        if ($Io -ge 0) {
            $status = [PbProcPriority]::SetIo($ProcessId, $Io)
            $parts += $(if ($status -eq 0) { "io=$Io" } else { "io=failed($status)" })
        }
        if ($Memory -ge 0) {
            $status = [PbProcPriority]::SetMem($ProcessId, $Memory)
            $parts += $(if ($status -eq 0) { "mem=$Memory" } else { "mem=failed($status)" })
        }
    } catch {
        $parts += "failed: $($_.Exception.Message)"
    }
    return ('pid {0}: {1}' -f $ProcessId, ($parts -join ' '))
}

function Get-PbProcessPriorityText {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    Initialize-PbProcPriorityType
    $cpu = 'gone'
    try { $cpu = [string](Get-Process -Id $ProcessId -ErrorAction Stop).PriorityClass } catch { }
    return ('pid {0}: cpu={1} io={2} mem={3}' -f $ProcessId, $cpu, [PbProcPriority]::GetIo($ProcessId), [PbProcPriority]::GetMem($ProcessId))
}

# Lowers one process (default: this one) to background priority unless the kill switch is set.
function Set-PbBackgroundPriority {
    param([int]$ProcessId = $PID, [string]$Label = 'script', [switch]$Quiet)
    if (-not (Test-PbLowPriorityOn)) {
        if ($Quiet) { return }
        Write-Host ("Background priority off ({0}={1}); {2} runs at normal priority." -f $PbLowPriorityEnvName, [Environment]::GetEnvironmentVariable($PbLowPriorityEnvName), $Label)
        return
    }
    $result = Set-PbProcessPriority -ProcessId $ProcessId -Cpu 'BelowNormal' -Io 0 -Memory 1
    if ($Quiet) { return }
    Write-Host ("Background priority for {0} ({1}=off to disable), children inherit: {2}" -f $Label, $PbLowPriorityEnvName, $result)
}

# Lowers the calling script's own process; everything it starts afterwards inherits it.
# -Quiet for scripts whose stdout is parsed (throwaway-server.ps1 -Json).
function Enter-PbBackgroundPriority {
    param([string]$Label = 'script', [switch]$Quiet)
    Set-PbBackgroundPriority -ProcessId $PID -Label $Label -Quiet:$Quiet
}
