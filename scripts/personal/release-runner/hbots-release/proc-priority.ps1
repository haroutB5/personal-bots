# Process priority helpers for the hbots release runner (dot-source). Windows PowerShell 5.1.
# Background work (backup, integrity checks) must not starve the live server's synchronous SQLite I/O:
# CPU BelowNormal, I/O priority Very Low (0), memory priority Very Low (1). Only ever applied to PIDs the runner
# started itself. Lowering never needs elevation.
if (-not ('HbotsProc' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HbotsProc {
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
# Lowers one PID. Returns a short text for the log. IO 0 = very low, memory 1 = very low.
function Set-HbotsBackgroundPriority([int]$ProcessId) {
    $parts = @()
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
        $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
        $parts += 'cpu=BelowNormal'
    } catch { $parts += 'cpu=failed' }
    $io = [HbotsProc]::SetIo($ProcessId, 0)
    $parts += $(if ($io -eq 0) { 'io=VeryLow' } else { "io=failed($io)" })
    $mem = [HbotsProc]::SetMem($ProcessId, 1)
    $parts += $(if ($mem -eq 0) { 'mem=VeryLow' } else { "mem=failed($mem)" })
    return ("pid {0}: {1}" -f $ProcessId, ($parts -join ' '))
}
function Get-HbotsPriorityText([int]$ProcessId) {
    $cpu = 'gone'
    try { $cpu = [string](Get-Process -Id $ProcessId -ErrorAction Stop).PriorityClass } catch { }
    return ("pid {0}: cpu={1} io={2} mem={3}" -f $ProcessId, $cpu, [HbotsProc]::GetIo($ProcessId), [HbotsProc]::GetMem($ProcessId))
}
# Direct and indirect children of a PID (CIM snapshot).
function Get-HbotsDescendants([int]$ProcessId) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
    $found = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($ProcessId)
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        foreach ($c in $all) {
            if ([int]$c.ParentProcessId -eq $cur -and [int]$c.ProcessId -ne $cur -and -not $found.Contains([int]$c.ProcessId)) {
                $found.Add([int]$c.ProcessId); $queue.Enqueue([int]$c.ProcessId)
            }
        }
    }
    return $found.ToArray()
}
