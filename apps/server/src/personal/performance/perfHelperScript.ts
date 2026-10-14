/**
 * The Windows counter helper for the Performance tab: one long-lived
 * PowerShell that reads PDH performance counters and the server's direct
 * children, and prints one JSON line per tick on stdout.
 *
 * Why a helper at all: Node cannot read performance counters. Why one process
 * and not one per tick: spawning PowerShell every 2 s costs seconds of CPU an
 * hour and litters the process list (the 1.67.2 brief writes this down).
 * `typeperf` cannot be used either: it fixes its wildcard instance list at
 * start, so a bot CLI or GPU engine that appears later never shows up (probed
 * 13 Oct: a process started mid-run got no column).
 *
 * Design points, all probed on Harout's laptop on 13 Oct:
 * - PDH through P/Invoke in embedded C#: one `PdhCollectQueryData` per tick
 *   plus array reads is ~10-20 ms wall for ~400 process instances, where
 *   `Get-Counter` took ~3 s and per-instance .NET `PerformanceCounter`
 *   objects ~0.6 s of CPU (both measured, both rejected).
 * - `PdhAddEnglishCounterW`, so the paths stay English on any locale.
 * - `\Process(*)\% Processor Time` is one-core normalized (a single-thread
 *   burner reads 100); the sampler divides by the logical processor count.
 * - `\Process(*)\ID Process` maps counter instances to real PIDs, and the
 *   three Process counters are zipped into one row per process.
 * - GPU engines: 370 instances on this laptop, nearly all idle leftovers, so
 *   only entries with a named engine type and real work are sent.
 * - The server's direct children (few rows) carry their command line; the
 *   sampler attributes provider CLI trees to bots from it.
 * - The helper exits by itself when the server PID it was told about is gone,
 *   so a crashed server never leaves an orphan reading counters.
 *
 * The script is embedded, not shipped as a file: the release is a single
 * `bin.mjs` plus externals, and a loose `.ps1` would not survive the copy.
 * It is written to `<baseDir>/personal/performance/perf-helper.ps1` at start,
 * which also makes a live session debuggable.
 */
export const PERF_HELPER_SCRIPT = String.raw`
# hbots Performance sampler helper. One long-lived process: PDH counters
# (P/Invoke) every tick, plus the direct children of the hbots server (with
# command lines) for process attribution. Writes one JSON line per tick to
# stdout. Exits when its parent (the server pid given with -ParentPid) is gone.
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [int]$TickMs = 2000
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class PdhCounter : IDisposable
{
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhOpenQueryW(string dataSource, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FmtValue value);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, out uint size, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")]
    static extern uint PdhCloseQuery(IntPtr query);

    const uint FMT_DOUBLE = 0x00000200;
    const uint CSTATUS_VALID_DATA = 0x0;
    const uint CSTATUS_NEW_DATA = 0x1;
    const uint MORE_DATA = 0x800007D2;

    // PDH_FMT_COUNTERVALUE: DWORD status, then the union (double for FMT_DOUBLE)
    // at offset 8 - the status must not be read as the value.
    [StructLayout(LayoutKind.Sequential)]
    struct FmtValue
    {
        public uint CStatus;
        public double Value;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FmtItem
    {
        public IntPtr Name;
        public uint CStatus;
        public double Value;
    }

    sealed class Entry
    {
        public string Key;
        public IntPtr Counter;
        public IntPtr Counter2;
        public IntPtr Counter3;
        public bool Multi;
        // 0 = plain, 1 = GPU engines (drop idle/unnamed), 2 = process zip.
        public int Mode;
    }

    IntPtr query;
    readonly List<Entry> entries = new List<Entry>();

    /// True on ticks that do not need the process rows (the sampler groups
    /// every second tick): the process array is the bulk of the line.
    public bool SkipProcess { get; set; }

    public PdhCounter()
    {
        uint rc = PdhOpenQueryW(null, IntPtr.Zero, out query);
        if (rc != 0) throw new Exception("PdhOpenQuery rc=" + rc);
    }

    public string Add(string key, string path, bool multi)
    {
        IntPtr counter;
        uint rc = PdhAddEnglishCounterW(query, path, IntPtr.Zero, out counter);
        if (rc != 0) return "PdhAddEnglishCounter " + key + " rc=" + rc;
        entries.Add(new Entry { Key = key, Counter = counter, Multi = multi });
        return null;
    }

    // The three Process(*) counters, read as one zipped array.
    public string AddProcess(string cpuPath, string memPath, string pidPath)
    {
        IntPtr cpu, mem, pid;
        uint rc = PdhAddEnglishCounterW(query, cpuPath, IntPtr.Zero, out cpu);
        if (rc != 0) return "PdhAddEnglishCounter procCpu rc=" + rc;
        rc = PdhAddEnglishCounterW(query, memPath, IntPtr.Zero, out mem);
        if (rc != 0) return "PdhAddEnglishCounter procMem rc=" + rc;
        rc = PdhAddEnglishCounterW(query, pidPath, IntPtr.Zero, out pid);
        if (rc != 0) return "PdhAddEnglishCounter procPid rc=" + rc;
        entries.Add(new Entry { Key = "proc", Counter = cpu, Counter2 = mem, Counter3 = pid, Multi = true, Mode = 2 });
        return null;
    }

    public string AddGpu(string path)
    {
        IntPtr counter;
        uint rc = PdhAddEnglishCounterW(query, path, IntPtr.Zero, out counter);
        if (rc != 0) return "PdhAddEnglishCounter gpu rc=" + rc;
        entries.Add(new Entry { Key = "gpu", Counter = counter, Multi = true, Mode = 1 });
        return null;
    }

    public void Collect()
    {
        uint rc = PdhCollectQueryData(query);
        if (rc != 0) throw new Exception("PdhCollectQueryData rc=" + rc);
    }

    static void AppendNum(StringBuilder sb, double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) { sb.Append("null"); return; }
        double rounded = Math.Round(value, 2);
        sb.Append(rounded.ToString("0.##", CultureInfo.InvariantCulture));
    }

    static void AppendName(StringBuilder sb, string name)
    {
        sb.Append('"');
        foreach (char c in name)
        {
            if (c == '"' || c == '\\') sb.Append('\\');
            sb.Append(c);
        }
        sb.Append('"');
    }

    // The [name, value] rows of one multi-instance counter, or null.
    // minValue (used for the GPU engines, ~370 mostly-idle instances) skips
    // decoding the name of anything below it: the name decode is the cost, and
    // an idle engine's name is never looked at.
    static List<KeyValuePair<string, double>> ReadArray(IntPtr counter, double minValue = double.NegativeInfinity)
    {
        uint size = 0;
        uint count = 0;
        uint rc = PdhGetFormattedCounterArrayW(counter, FMT_DOUBLE, out size, out count, IntPtr.Zero);
        if (rc != MORE_DATA && rc != 0) return null;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            rc = PdhGetFormattedCounterArrayW(counter, FMT_DOUBLE, out size, out count, buffer);
            if (rc != 0) return null;
            var rows = new List<KeyValuePair<string, double>>((int)count);
            int stride = Marshal.SizeOf(typeof(FmtItem));
            for (int i = 0; i < count; i++)
            {
                FmtItem item = (FmtItem)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + i * stride), typeof(FmtItem));
                bool valid = item.CStatus == CSTATUS_VALID_DATA || item.CStatus == CSTATUS_NEW_DATA;
                double value = valid ? item.Value : double.NaN;
                if (double.IsNaN(value) || value < minValue) continue;
                string name = item.Name == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(item.Name) ?? "");
                rows.Add(new KeyValuePair<string, double>(name, value));
            }
            return rows;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    // One tick as { "key": value, "gpu": [[name, value], ...], "proc": [[name, cpu, mem, pid], ...] }.
    public string ReadJson()
    {
        var sb = new StringBuilder(4096);
        sb.Append('{');
        bool first = true;
        foreach (Entry e in entries)
        {
            if (!first) sb.Append(',');
            first = false;
            AppendName(sb, e.Key);
            sb.Append(':');
            if (!e.Multi)
            {
                uint type;
                FmtValue value;
                uint rc = PdhGetFormattedCounterValue(e.Counter, FMT_DOUBLE, out type, out value);
                if (rc != 0 || (value.CStatus != CSTATUS_VALID_DATA && value.CStatus != CSTATUS_NEW_DATA)) sb.Append("null");
                else AppendNum(sb, value.Value);
                continue;
            }
            if (e.Mode == 2)
            {
                // The process rows are the bulk of the line and the sampler
                // only groups every second tick, so odd ticks skip them.
                if (SkipProcess) { sb.Append("null"); continue; }
                // Process(*): one zipped row per process; the three counter
                // instance lists are identical within a collect.
                var cpu = ReadArray(e.Counter);
                var mem = ReadArray(e.Counter2);
                var pid = ReadArray(e.Counter3);
                if (cpu == null || mem == null || pid == null) { sb.Append("null"); continue; }
                sb.Append('[');
                int n = Math.Min(cpu.Count, Math.Min(mem.Count, pid.Count));
                for (int i = 0; i < n; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('[');
                    AppendName(sb, cpu[i].Key);
                    sb.Append(',');
                    AppendNum(sb, cpu[i].Value);
                    sb.Append(',');
                    AppendNum(sb, mem[i].Value);
                    sb.Append(',');
                    AppendNum(sb, pid[i].Value);
                    sb.Append(']');
                }
                sb.Append(']');
                continue;
            }
            var rows = ReadArray(e.Counter, e.Mode == 1 ? 0.05 : double.NegativeInfinity);
            if (rows == null) { sb.Append("null"); continue; }
            sb.Append('[');
            int written = 0;
            foreach (var row in rows)
            {
                if (e.Mode == 1)
                {
                    // GPU engines: only named engine types (the unnamed
                    // overlay leftovers are noise; idle ones never got here).
                    int idx = row.Key.LastIndexOf("engtype_", StringComparison.Ordinal);
                    if (idx < 0 || idx + 8 >= row.Key.Length) continue;
                    if (written >= 80) break;
                }
                if (written > 0) sb.Append(',');
                written++;
                sb.Append('[');
                AppendName(sb, row.Key);
                sb.Append(',');
                AppendNum(sb, row.Value);
                sb.Append(']');
            }
            sb.Append(']');
            continue;
        }
        sb.Append('}');
        return sb.ToString();
    }

    public void Dispose()
    {
        if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; }
    }

    // ---- The process tree, natively -------------------------------------
    // CreateToolhelp32Snapshot gives pid, parent pid and image name for every
    // process in a few milliseconds. The WMI alternative (Get-CimInstance) was
    // measured at 350-450 ms of wall time per call on this laptop and spends
    // its CPU in the WMI service; this is the same data without that tax.

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    // [[pid, parentPid, sessionId], ...] for every live process, or "null".
    public static string ProcessTreeJson()
    {
        const uint TH32CS_SNAPPROCESS = 0x00000002;
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return "null";
        try
        {
            var sb = new StringBuilder(8192);
            sb.Append('[');
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool first = true;
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    uint session = 0;
                    ProcessIdToSessionId(entry.th32ProcessID, out session);
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('[').Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append(',').Append(session).Append(']');
                }
                while (Process32NextW(snapshot, ref entry));
            }
            sb.Append(']');
            return sb.ToString();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp | Out-Null

$pdh = New-Object PdhCounter
$warnings = New-Object System.Collections.Generic.List[string]
$single = @(
  @('cpuUtility', '\Processor Information(_Total)\% Processor Utility'),
  @('cpuPerformance', '\Processor Information(_Total)\% Processor Performance'),
  @('memAvailableMB', '\Memory\Available MBytes'),
  @('diskIdlePct', '\PhysicalDisk(_Total)\% Idle Time'),
  @('diskReadBps', '\PhysicalDisk(_Total)\Disk Read Bytes/sec'),
  @('diskWriteBps', '\PhysicalDisk(_Total)\Disk Write Bytes/sec')
)
foreach ($s in $single) { $w = $pdh.Add($s[0], $s[1], $false); if ($w) { $warnings.Add($w) | Out-Null } }
$w = $pdh.Add('threads', '\Processor Information(0,*)\% Processor Utility', $true); if ($w) { $warnings.Add($w) | Out-Null }
$w = $pdh.Add('netRx', '\Network Interface(*)\Bytes Received/sec', $true); if ($w) { $warnings.Add($w) | Out-Null }
$w = $pdh.Add('netTx', '\Network Interface(*)\Bytes Sent/sec', $true); if ($w) { $warnings.Add($w) | Out-Null }
$w = $pdh.AddGpu('\GPU Engine(*)\Utilization Percentage'); if ($w) { $warnings.Add($w) | Out-Null }
$w = $pdh.AddProcess('\Process(*)\% Processor Time', '\Process(*)\Working Set - Private', '\Process(*)\ID Process'); if ($w) { $warnings.Add($w) | Out-Null }
foreach ($w in $warnings) { [Console]::Error.WriteLine("perf-helper: $w") }

# One-time machine facts for the footer and the thresholds.
$hello = $null
try {
  $os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize, LastBootUpTime
  $cs = Get-CimInstance Win32_ComputerSystem -Property Model
  $cpuInfo = Get-CimInstance Win32_Processor -Property Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed | Select-Object -First 1
  $gpuInfo = Get-CimInstance Win32_VideoController -Property Name | Select-Object -First 1
  $bootMs = 0
  if ($os.LastBootUpTime) { $bootMs = [long]($os.LastBootUpTime.ToFileTimeUtc() / 10000 - 11644473600000) }
  $hello = '{"kind":"hello","hv":1' +
    ',"memTotalMB":' + [long]([long]$os.TotalVisibleMemorySize / 1024) +
    ',"pcBootAt":' + $bootMs +
    ',"model":' + ([string]$cs.Model | ConvertTo-Json -Compress) +
    ',"cpuName":' + ([string]$cpuInfo.Name | ConvertTo-Json -Compress) +
    ',"physCores":' + [int]$cpuInfo.NumberOfCores +
    ',"logicalProcessors":' + [int]$cpuInfo.NumberOfLogicalProcessors +
    ',"maxClockMHz":' + [int]$cpuInfo.MaxClockSpeed +
    ',"gpuName":' + ([string]$gpuInfo.Name | ConvertTo-Json -Compress) + '}'
} catch { $hello = '{"kind":"hello","hv":1}' }

# Prime: % counters need two collects before they are meaningful.
$pdh.Collect() | Out-Null
Start-Sleep -Milliseconds 300

$out = [Console]::Out
$out.WriteLine($hello)
$out.Flush()

$tick = 0
$next = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $TickMs
while ($true) {
  $tick++
  if ($tick % 10 -eq 1) {
    $parent = $null
    try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { }
    if ($null -eq $parent) { break }
  }
  $groupTick = ($tick % 2 -eq 0)
  $pdh.SkipProcess = -not $groupTick
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $pdh.Collect()
  $counters = $pdh.ReadJson()
  $collectMs = $sw.ElapsedMilliseconds

  # The server's direct children (few rows, with command lines, for
  # attribution): only on group ticks, together with the parent map.
  $sb = New-Object System.Text.StringBuilder
  if ($groupTick) {
    $sb.Append('[') | Out-Null
    $first = $true
    try {
      $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -Property ProcessId, Name, CommandLine, KernelModeTime, UserModeTime, WorkingSetSize
      foreach ($c in $children) {
        if (-not $first) { $sb.Append(',') | Out-Null }
        $first = $false
        $cmd = $c.CommandLine
        if ($null -eq $cmd) { $cmd = '' }
        if ($cmd.Length -gt 4000) { $cmd = $cmd.Substring(0, 4000) }
        $cmdJson = $cmd | ConvertTo-Json -Compress
        $nameJson = [string]$c.Name | ConvertTo-Json -Compress
        $cpu100ns = [long]$c.KernelModeTime + [long]$c.UserModeTime
        $sb.Append('{"pid":' + $c.ProcessId + ',"name":' + $nameJson + ',"cpu100ns":' + $cpu100ns + ',"wsBytes":' + [long]$c.WorkingSetSize + ',"cmd":' + $cmdJson + '}') | Out-Null
      }
    } catch { }
    $sb.Append(']') | Out-Null
  } else {
    $sb.Append('[]') | Out-Null
  }

  # Every tenth tick (~20 s): the slow facts - battery and the C: drive.
  $slow = ''
  if ($tick % 10 -eq 1) {
    try {
      $batt = Get-CimInstance Win32_Battery -Property EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime -ErrorAction Stop | Select-Object -First 1
      $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property Size, FreeSpace
      $state = 'unknown'
      if ($batt) {
        switch ([int]$batt.BatteryStatus) {
          1 { $state = 'discharging' }
          2 { $state = 'plugged' }
          3 { $state = 'full' }
          6 { $state = 'charging' }
          7 { $state = 'charging' }
          8 { $state = 'charging' }
          9 { $state = 'charging' }
          11 { $state = 'charging' }
        }
      }
      $pct = 'null'
      $minutes = 'null'
      if ($batt) {
        $pct = [string][int]$batt.EstimatedChargeRemaining
        if ([int]$batt.EstimatedRunTime -gt 0 -and [int]$batt.EstimatedRunTime -lt 71582788) { $minutes = [string][int]$batt.EstimatedRunTime }
      }
      $totalGB = 'null'
      $freeGB = 'null'
      if ($disk) {
        $totalGB = [string]([math]::Round([long]$disk.Size / 1e9 * 10) / 10)
        $freeGB = [string]([math]::Round([long]$disk.FreeSpace / 1e9 * 10) / 10)
      }
      $slow = ',"s":{"batteryPct":' + $pct + ',"batteryState":"' + $state + '","batteryMinutesLeft":' + $minutes +
        ',"diskTotalGB":' + $totalGB + ',"diskFreeGB":' + $freeGB + '}'
    } catch { $slow = ',"s":null' }
  }

  # Every other tick: the whole process tree's parent links and sessions, so
  # the sampler can group descendants of the server's children. Native, a few
  # milliseconds, no WMI.
  $pp = ''
  if ($groupTick) {
    $pp = ',"pp":' + [PdhCounter]::ProcessTreeJson()
  }

  $line = '{"t":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"ms":' + $collectMs + ',"c":' + $counters + ',"k":' + $sb.ToString() + $pp + $slow + '}'
  $out.WriteLine($line)
  $out.Flush()
  # Keep the cadence: sleep only for what is left of the tick, so the CIM
  # calls never push the series to 2.5 s steps.
  $left = $next - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($left -gt 0) { Start-Sleep -Milliseconds $left }
  $next += $TickMs
}
`;
