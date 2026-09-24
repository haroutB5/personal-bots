/**
 * Source of the Windows desktop helper, compiled on first use with the C#
 * compiler every Windows install ships (.NET Framework 4, `csc.exe`). Kept as
 * a string so the bundled server carries it without packaging changes, and so
 * the compiled exe is keyed by the hash of exactly this text.
 *
 * C# 5 only: the framework compiler predates string interpolation, `?.` and
 * expression-bodied members.
 *
 * Protocol: one JSON object per line on stdin (`{"id":1,"cmd":"..."}`), one
 * JSON object per line on stdout: `{"id":1,"ok":true,...}` replies, and
 * unsolicited `{"event":"kill"}` when the user presses the stop hotkey.
 * Commands run one at a time on a worker thread, except `abort`, which the
 * reader answers at once: it ends whatever action is running.
 *
 * Every injected event carries a tag in `dwExtraInfo` so the hooks can tell
 * who sent it: 0x50420001 for a bot's input, 0x50420002 for the owner's
 * remote control from the app (commands with `"remote": true`). Anything
 * untagged is the person at the PC: it pauses bots and its Esc is the stop
 * key. Remote input never waits for the PC's user to go quiet (the owner is
 * the user) and never trips the stop key.
 *
 * The helper is per-monitor DPI aware (v2), so every coordinate it reads or
 * takes is a physical pixel on the virtual screen, whose origin can be
 * negative when a monitor sits left of or above the primary.
 */
export const DESKTOP_HELPER_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
  [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr hdc, int mode);
  [DllImport("gdi32.dll")] public static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr previous);

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
}

class Overlay : Form {
  readonly bool label;
  readonly string text;
  readonly float fontPx;
  readonly bool capturable;
  public Overlay(Rectangle bounds, Color color, bool label, string text, float fontPx, bool capturable) {
    this.label = label; this.text = text; this.fontPx = fontPx; this.capturable = capturable;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.None;
    TopMost = true;
    BackColor = color;
    Opacity = label ? 0.92 : 0.85;
    Bounds = bounds;
    DoubleBuffered = true;
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      // Layered + transparent: every click goes through to what is underneath.
      cp.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000 | 0x00000008;
      return cp;
    }
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    // Kept out of the bot's own screenshots (Windows 10 2004+).
    if (!capturable) Native.SetWindowDisplayAffinity(Handle, 0x11);
  }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);
    if (!label) return;
    e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
    using (Font font = new Font("Segoe UI", fontPx, FontStyle.Bold, GraphicsUnit.Pixel)) {
      StringFormat format = new StringFormat();
      format.Alignment = StringAlignment.Center;
      format.LineAlignment = StringAlignment.Center;
      e.Graphics.DrawString(text, font, Brushes.White, new RectangleF(0, 0, Width, Height), format);
    }
  }
}

class Monitor {
  public int Index; public bool Primary; public Rectangle Bounds; public int Dpi; public string Name;
}

public static class PbDesktopHelper {
  static readonly object outLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static Control ui;
  static readonly List<Overlay> overlays = new List<Overlay>();
  static System.Windows.Forms.Timer topmostTimer;
  static IntPtr keyboardHook = IntPtr.Zero, mouseHook = IntPtr.Zero;
  static Native.HookProc keyboardProc, mouseProc;
  static volatile int abortGeneration = 0;
  static long lastPhysicalInput = 0;
  // The owner's remote input from the app: user activity as far as bots are
  // concerned, but never the person at the PC.
  static long lastRemoteInput = 0;
  static bool physCtrl = false, physAlt = false, swallowEscUp = false;
  /** True while the overlay is up, i.e. while a bot holds the PC. */
  static volatile bool armed = false;
  // Stamped on every event this helper injects, so the hooks can tell the
  // bot's own input from the user's (hardware, or any other program).
  static readonly IntPtr SelfTag = new IntPtr(0x50420001);
  // Stamped on the owner's remote-control input (see the header comment).
  static readonly IntPtr RemoteTag = new IntPtr(0x50420002);
  // The tag the command being run injects with, and whether it is remote.
  static IntPtr injectTag = SelfTag;
  static bool remoteCmd = false;
  static readonly BlockingCollection<string> work = new BlockingCollection<string>();

  // 0: the person at the PC (hardware, or another program); 1: a bot, through
  // this helper; 2: the owner's remote control, through this helper.
  static int Classify(IntPtr extra) {
    if (extra == SelfTag) return 1;
    if (extra == RemoteTag) return 2;
    return 0;
  }

  static TextReader input;
  static TextWriter output;

  // Entry point, called from a PowerShell host that loads this assembly from
  // bytes: Smart App Control blocks a freshly compiled unsigned exe outright,
  // while the signed powershell.exe may run code it loads itself.
  public static void Run() {
    json.MaxJsonLength = int.MaxValue;
    UTF8Encoding utf8 = new UTF8Encoding(false);
    input = new StreamReader(Console.OpenStandardInput(), utf8);
    StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), utf8);
    writer.AutoFlush = true;
    output = writer;
    // The host may already carry a DPI mode from its manifest, so the process
    // call can fail; each thread below also sets its own per-monitor context.
    Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
    Thread uiThread = new Thread(UiMain);
    uiThread.SetApartmentState(ApartmentState.STA);
    uiThread.Start();
    uiThread.Join();
  }

  static void UiMain() {
    Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
    ui = new Control();
    ui.CreateControl();
    IntPtr force = ui.Handle;
    keyboardProc = KeyboardHook;
    mouseProc = MouseHook;
    IntPtr module = Native.GetModuleHandle(null);
    keyboardHook = Native.SetWindowsHookEx(13, keyboardProc, module, 0);
    mouseHook = Native.SetWindowsHookEx(14, mouseProc, module, 0);
    topmostTimer = new System.Windows.Forms.Timer();
    topmostTimer.Interval = 1500;
    topmostTimer.Tick += delegate {
      foreach (Overlay o in overlays) Native.SetWindowPos(o.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    };
    topmostTimer.Start();
    Thread reader = new Thread(ReadLoop);
    reader.IsBackground = true;
    reader.Start();
    Emit(Dict("event", "ready", "hooks", keyboardHook != IntPtr.Zero && mouseHook != IntPtr.Zero));
    Application.Run();
    if (keyboardHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboardHook);
    if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
  }

  static Dictionary<string, object> Dict(params object[] pairs) {
    Dictionary<string, object> d = new Dictionary<string, object>();
    for (int i = 0; i + 1 < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
    return d;
  }

  static void Emit(Dictionary<string, object> message) {
    string line = json.Serialize(message);
    lock (outLock) { output.WriteLine(line); }
  }

  static IntPtr KeyboardHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      Native.KBDLLHOOKSTRUCT k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Native.KBDLLHOOKSTRUCT));
      if (Classify(k.extra) == 0) {
        int msg = w.ToInt32();
        bool down = msg == 0x0100 || msg == 0x0104;
        uint vk = k.vkCode;
        if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) physCtrl = down;
        else if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) physAlt = down;
        Interlocked.Exchange(ref lastPhysicalInput, DateTime.UtcNow.Ticks);
        // While a bot holds the PC, the user's Esc (alone or as
        // Ctrl+Alt+Esc) stops it. The key is eaten, so on-screen content can
        // never use that Esc to dismiss a dialog the user meant to keep.
        if (vk == 0x1B && (armed || swallowEscUp)) {
          if (down) {
            if (!swallowEscUp) {
              swallowEscUp = true;
              Interlocked.Increment(ref abortGeneration);
              Emit(Dict("event", "kill"));
            }
          } else {
            swallowEscUp = false;
          }
          return new IntPtr(1);
        }
      }
    }
    return Native.CallNextHookEx(keyboardHook, code, w, l);
  }

  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      Native.MSLLHOOKSTRUCT m = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Native.MSLLHOOKSTRUCT));
      if (Classify(m.extra) == 0) Interlocked.Exchange(ref lastPhysicalInput, DateTime.UtcNow.Ticks);
    }
    return Native.CallNextHookEx(mouseHook, code, w, l);
  }

  static double MsSince(long last) {
    if (last == 0) return double.MaxValue;
    return (DateTime.UtcNow.Ticks - last) / 10000.0;
  }

  // Anyone using the PC as far as a bot is concerned: the person at it, or
  // the owner controlling it remotely.
  static double MsSinceUserInput() {
    return Math.Min(MsSince(Interlocked.Read(ref lastPhysicalInput)), MsSince(Interlocked.Read(ref lastRemoteInput)));
  }

  // Reads commands. "abort" is answered here at once, so a stop can end the
  // action the worker is in the middle of; everything else runs in order on
  // the worker.
  static void ReadLoop() {
    Thread worker = new Thread(WorkLoop);
    worker.IsBackground = true;
    worker.Start();
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      if (line.IndexOf("\"abort\"", StringComparison.Ordinal) >= 0) {
        object id = null;
        try {
          Dictionary<string, object> req = json.Deserialize<Dictionary<string, object>>(line);
          if (Str(req, "cmd") == "abort") {
            id = req.ContainsKey("id") ? req["id"] : null;
            Interlocked.Increment(ref abortGeneration);
            Emit(Dict("id", id, "ok", true));
            continue;
          }
        } catch (Exception) { }
      }
      work.Add(line);
    }
    work.CompleteAdding();
    worker.Join(5000);
    try { ui.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); }); } catch (Exception) { }
    Thread.Sleep(500);
    Environment.Exit(0);
  }

  static void WorkLoop() {
    Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
    foreach (string line in work.GetConsumingEnumerable()) {
      object id = null;
      try {
        Dictionary<string, object> req = json.Deserialize<Dictionary<string, object>>(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        Dictionary<string, object> result = Handle(req);
        result["id"] = id;
        result["ok"] = true;
        Emit(result);
      } catch (HelperError e) {
        Emit(Dict("id", id, "ok", false, "code", e.Code, "error", e.Message));
      } catch (Exception e) {
        Emit(Dict("id", id, "ok", false, "code", "internal", "error", e.GetType().Name + ": " + e.Message));
      }
    }
  }

  class HelperError : Exception {
    public string Code;
    public HelperError(string code, string message) : base(message) { Code = code; }
  }

  static int Int(Dictionary<string, object> r, string key) { return Convert.ToInt32(r[key]); }
  static int IntOr(Dictionary<string, object> r, string key, int fallback) { return r.ContainsKey(key) && r[key] != null ? Convert.ToInt32(r[key]) : fallback; }
  static string Str(Dictionary<string, object> r, string key) { return r.ContainsKey(key) && r[key] != null ? Convert.ToString(r[key]) : null; }
  static bool BoolOr(Dictionary<string, object> r, string key, bool fallback) { return r.ContainsKey(key) && r[key] != null ? Convert.ToBoolean(r[key]) : fallback; }

  static Dictionary<string, object> Handle(Dictionary<string, object> r) {
    string cmd = Str(r, "cmd");
    remoteCmd = BoolOr(r, "remote", false);
    injectTag = remoteCmd ? RemoteTag : SelfTag;
    switch (cmd) {
      case "ping": return Dict("pong", true);
      case "abort": Interlocked.Increment(ref abortGeneration); return Dict();
      case "inputState": return Dict("msSinceUserInput", Math.Min(MsSinceUserInput(), 1e9),
        "msSincePhysicalInput", Math.Min(MsSince(Interlocked.Read(ref lastPhysicalInput)), 1e9));
      case "info": return Info();
      case "screenshot": return Screenshot(r);
      case "cursor": { Native.POINT p; Native.GetCursorPos(out p); return Dict("x", p.X, "y", p.Y); }
      case "overlay": return OverlayCmd(r);
      case "move": Guard(r); MoveTo(Int(r, "x"), Int(r, "y")); return Dict();
      case "click": Guard(r); return Click(r);
      case "button": Guard(r); return ButtonCmd(r);
      case "drag": Guard(r); return Drag(r);
      case "scroll": Guard(r); return Scroll(r);
      case "wheel": Guard(r); return Wheel(r);
      case "type": Guard(r); return TypeText(r);
      case "keys": Guard(r); return Keys(r);
      default: throw new HelperError("bad_command", "Unknown command " + cmd);
    }
  }

  static void Guard(Dictionary<string, object> r) {
    if (remoteCmd) GuardRemote(); else GuardUser(r);
  }

  // The owner's own input from the app: never into the lock screen or a
  // secure prompt, and no waiting for the person at the PC to go quiet.
  static void GuardRemote() {
    if (Locked()) throw new HelperError("locked", "The PC is locked, or a secure Windows prompt is showing.");
    Interlocked.Exchange(ref lastRemoteInput, DateTime.UtcNow.Ticks);
  }

  // Locked: the session reports it (the lock screen curtain is an app on the
  // user's own desktop, so only the session knows), or the input desktop is
  // not "Default" (sign-in box, UAC prompt, Ctrl+Alt+Del run on "Winlogon",
  // which this process cannot even open).
  static bool Locked() {
    IntPtr info;
    int bytes;
    if (Native.WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out info, out bytes)) {
      try {
        // WTSINFOEX: Level (DWORD), then the 8-byte aligned WTSINFOEX_LEVEL1
        // union at offset 8: SessionId (8), SessionState (12), SessionFlags (16).
        // SessionFlags: 0 = WTS_SESSIONSTATE_LOCK, 1 = UNLOCK, -1 = unknown.
        int flags = Marshal.ReadInt32(info, 16);
        if (flags == 0) return true;
      } finally {
        Native.WTSFreeMemory(info);
      }
    }
    IntPtr desktop = Native.OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return true;
    try {
      StringBuilder name = new StringBuilder(256);
      int needed;
      if (!Native.GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return false;
      return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    } finally {
      Native.CloseDesktop(desktop);
    }
  }

  // Waits for the user's own mouse and keyboard to go quiet before injecting,
  // so a bot never fights a person who is using the PC. Never injects into
  // the lock screen or a secure prompt, where keys could land in a password box.
  static void GuardUser(Dictionary<string, object> r) {
    if (Locked()) throw new HelperError("locked", "The PC is locked, or a secure Windows prompt is showing.");
    int quietMs = IntOr(r, "quietMs", 1200);
    int maxWaitMs = IntOr(r, "maxWaitMs", 8000);
    int gen = abortGeneration;
    DateTime until = DateTime.UtcNow.AddMilliseconds(maxWaitMs);
    while (MsSinceUserInput() < quietMs) {
      if (abortGeneration != gen) throw new HelperError("aborted", "Stopped by the user.");
      if (DateTime.UtcNow > until) throw new HelperError("user_active", "The user is using the mouse or keyboard right now.");
      Thread.Sleep(50);
    }
  }

  static void CheckInterrupted(int gen, long startTicks) {
    if (abortGeneration != gen) throw new HelperError("aborted", "Stopped by the user.");
    // The owner's remote input is theirs to interleave with; a bot's stops
    // part way when anyone else touches the PC.
    if (remoteCmd) return;
    if (Interlocked.Read(ref lastPhysicalInput) > startTicks || Interlocked.Read(ref lastRemoteInput) > startTicks) throw new HelperError("user_active", "The user started using the mouse or keyboard, so the action stopped part way.");
  }

  static List<Monitor> Monitors() {
    List<Monitor> list = new List<Monitor>();
    Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, ref Native.RECT rc, IntPtr d) {
      Native.MONITORINFOEX mi = new Native.MONITORINFOEX();
      mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
      Native.GetMonitorInfo(h, ref mi);
      uint dx = 96, dy = 96;
      try { Native.GetDpiForMonitor(h, 0, out dx, out dy); } catch (Exception) { }
      Monitor m = new Monitor();
      m.Primary = (mi.dwFlags & 1) != 0;
      m.Bounds = Rectangle.FromLTRB(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom);
      m.Dpi = (int)dx;
      m.Name = mi.szDevice;
      list.Add(m);
      return true;
    }, IntPtr.Zero);
    list.Sort(delegate(Monitor a, Monitor b) {
      if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
      if (a.Bounds.X != b.Bounds.X) return a.Bounds.X.CompareTo(b.Bounds.X);
      return a.Bounds.Y.CompareTo(b.Bounds.Y);
    });
    for (int i = 0; i < list.Count; i++) list[i].Index = i;
    return list;
  }

  static Dictionary<string, object> Info() {
    ArrayList monitors = new ArrayList();
    foreach (Monitor m in Monitors()) {
      monitors.Add(Dict("index", m.Index, "primary", m.Primary, "x", m.Bounds.X, "y", m.Bounds.Y,
        "width", m.Bounds.Width, "height", m.Bounds.Height, "dpi", m.Dpi, "name", m.Name));
    }
    return Dict("monitors", monitors, "locked", Locked(),
      "virtual", Dict("x", Native.GetSystemMetrics(76), "y", Native.GetSystemMetrics(77),
        "width", Native.GetSystemMetrics(78), "height", Native.GetSystemMetrics(79)));
  }

  static Dictionary<string, object> Screenshot(Dictionary<string, object> r) {
    int x = Int(r, "x"), y = Int(r, "y"), w = Int(r, "width"), h = Int(r, "height");
    int ow = Int(r, "outWidth"), oh = Int(r, "outHeight");
    bool cursor = BoolOr(r, "cursor", true);
    using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        if (cursor) DrawCursor(g, x, y);
      }
      Bitmap output = full;
      bool scaled = ow != w || oh != h;
      if (scaled) {
        output = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);
        using (Graphics g2 = Graphics.FromImage(output)) {
          g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g2.CompositingQuality = CompositingQuality.HighQuality;
          g2.DrawImage(full, new Rectangle(0, 0, ow, oh));
        }
      }
      try {
        string format = Str(r, "format") ?? "auto";
        int quality = Math.Max(30, Math.Min(95, IntOr(r, "quality", 80)));
        int pngLimit = IntOr(r, "pngLimit", 400000);
        byte[] png = null;
        if (format == "png" || format == "auto") png = Encode(output, null, 0);
        if (format == "png" || (format == "auto" && png.Length <= pngLimit)) {
          return Dict("data", Convert.ToBase64String(png), "mimeType", "image/png", "width", ow, "height", oh);
        }
        byte[] jpeg = Encode(output, "image/jpeg", quality);
        if (png != null && png.Length <= jpeg.Length) {
          return Dict("data", Convert.ToBase64String(png), "mimeType", "image/png", "width", ow, "height", oh);
        }
        return Dict("data", Convert.ToBase64String(jpeg), "mimeType", "image/jpeg", "width", ow, "height", oh);
      } finally {
        if (scaled) output.Dispose();
      }
    }
  }

  // ---- Live view: a second, capture-only process -------------------------
  //
  // The app's live view runs this entry in its own powershell.exe, so a frame
  // grab can never queue behind (or reorder) a bot's clicks and typing in the
  // main helper, and watching never installs the input hooks or the overlay.
  // One GDI StretchBlt (HALFTONE) copies and scales the screen in a single
  // step, which is far cheaper than CopyFromScreen at full size plus a bicubic
  // pass. Windows the overlay excludes from capture stay excluded here too.
  public static void RunCapture() {
    json.MaxJsonLength = int.MaxValue;
    UTF8Encoding utf8 = new UTF8Encoding(false);
    input = new StreamReader(Console.OpenStandardInput(), utf8);
    StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), utf8);
    writer.AutoFlush = true;
    output = writer;
    Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
    Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
    Emit(Dict("event", "ready", "mode", "capture"));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      object id = null;
      try {
        Dictionary<string, object> req = json.Deserialize<Dictionary<string, object>>(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        string cmd = Str(req, "cmd");
        Dictionary<string, object> result;
        if (cmd == "ping") result = Dict("pong", true);
        else if (cmd == "frame") result = LiveFrame(req);
        else throw new HelperError("bad_command", "Unknown capture command " + cmd);
        result["id"] = id;
        result["ok"] = true;
        Emit(result);
      } catch (HelperError e) {
        Emit(Dict("id", id, "ok", false, "code", e.Code, "error", e.Message));
      } catch (Exception e) {
        Emit(Dict("id", id, "ok", false, "code", "internal", "error", e.GetType().Name + ": " + e.Message));
      }
    }
    Environment.Exit(0);
  }

  static ImageCodecInfo jpegCodec;

  // One frame of the live view: the chosen monitor scaled to fit the box, the
  // cursor drawn in, JPEG. "unchanged" (nothing encoded) when the pixels hash
  // the same as the frame the viewer already has; "locked" (nothing captured)
  // while the PC is locked or a secure prompt is up.
  static Dictionary<string, object> LiveFrame(Dictionary<string, object> r) {
    if (Locked()) return Dict("locked", true);
    int maxW = Math.Max(64, IntOr(r, "maxWidth", 1280));
    int maxH = Math.Max(64, IntOr(r, "maxHeight", 1280));
    int quality = Math.Max(30, Math.Min(95, IntOr(r, "quality", 70)));
    string lastHash = Str(r, "lastHash");
    List<Monitor> monitors = Monitors();
    if (monitors.Count == 0) throw new HelperError("capture_failed", "No monitor is attached.");
    Monitor m = monitors[Math.Max(0, Math.Min(monitors.Count - 1, IntOr(r, "monitor", 0)))];
    Rectangle b = m.Bounds;
    double scale = Math.Min(1.0, Math.Min((double)maxW / b.Width, (double)maxH / b.Height));
    int ow = Math.Max(1, (int)Math.Round(b.Width * scale));
    int oh = Math.Max(1, (int)Math.Round(b.Height * scale));
    System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
    using (Bitmap frame = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(frame)) {
        IntPtr dst = g.GetHdc();
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        bool copied;
        try {
          Native.SetStretchBltMode(dst, 4);
          Native.SetBrushOrgEx(dst, 0, 0, IntPtr.Zero);
          copied = Native.StretchBlt(dst, 0, 0, ow, oh, screen, b.X, b.Y, b.Width, b.Height, 0x00CC0020);
        } finally {
          Native.ReleaseDC(IntPtr.Zero, screen);
          g.ReleaseHdc(dst);
        }
        if (!copied) throw new HelperError("capture_failed", "The screen could not be captured.");
        DrawCursorScaled(g, b.X, b.Y, scale, m.Dpi);
      }
      long captureMs = watch.ElapsedMilliseconds;
      string hash = HashPixels(frame);
      if (lastHash != null && hash == lastHash) {
        return Dict("unchanged", true, "hash", hash, "width", ow, "height", oh, "captureMs", captureMs);
      }
      watch.Reset();
      watch.Start();
      if (jpegCodec == null) {
        foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == "image/jpeg") jpegCodec = candidate;
      }
      byte[] jpeg;
      using (MemoryStream ms = new MemoryStream()) {
        EncoderParameters parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        frame.Save(ms, jpegCodec, parameters);
        jpeg = ms.ToArray();
      }
      return Dict("data", Convert.ToBase64String(jpeg), "width", ow, "height", oh, "hash", hash,
        "captureMs", captureMs, "encodeMs", watch.ElapsedMilliseconds,
        "screenWidth", b.Width, "screenHeight", b.Height, "monitors", monitors.Count);
    }
  }

  // FNV-1a over the scaled pixels: a few ms for a phone-sized frame, and it
  // lets an idle screen cost a capture but no encode and no bytes on the wire.
  static string HashPixels(Bitmap frame) {
    BitmapData data = frame.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      int length = Math.Abs(data.Stride) * data.Height;
      byte[] bytes = new byte[length];
      Marshal.Copy(data.Scan0, bytes, 0, length);
      ulong h = 14695981039346656037UL;
      for (int i = 0; i < length; i++) { h ^= bytes[i]; h *= 1099511628211UL; }
      return h.ToString("x16");
    } finally {
      frame.UnlockBits(data);
    }
  }

  static void DrawCursorScaled(Graphics g, int originX, int originY, double scale, int dpi) {
    Native.CURSORINFO ci = new Native.CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
    if (!Native.GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
    Native.ICONINFO info;
    int hx = 0, hy = 0;
    if (Native.GetIconInfo(ci.hCursor, out info)) {
      hx = info.xHotspot; hy = info.yHotspot;
      if (info.hbmMask != IntPtr.Zero) Native.DeleteObject(info.hbmMask);
      if (info.hbmColor != IntPtr.Zero) Native.DeleteObject(info.hbmColor);
    }
    // The cursor's physical size, scaled with the frame; never so small it vanishes.
    double physical = 32.0 * dpi / 96.0;
    int size = Math.Max(12, (int)Math.Round(physical * scale));
    double k = size / physical;
    int x = (int)Math.Round((ci.pt.X - originX) * scale - hx * k);
    int y = (int)Math.Round((ci.pt.Y - originY) * scale - hy * k);
    IntPtr hdc = g.GetHdc();
    try { Native.DrawIconEx(hdc, x, y, ci.hCursor, size, size, 0, IntPtr.Zero, 3); }
    finally { g.ReleaseHdc(hdc); }
  }

  static byte[] Encode(Bitmap image, string mime, int quality) {
    using (MemoryStream ms = new MemoryStream()) {
      if (mime == null) {
        image.Save(ms, ImageFormat.Png);
      } else {
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == mime) codec = candidate;
        EncoderParameters parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        image.Save(ms, codec, parameters);
      }
      return ms.ToArray();
    }
  }

  static void DrawCursor(Graphics g, int originX, int originY) {
    Native.CURSORINFO ci = new Native.CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
    if (!Native.GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
    Native.ICONINFO info;
    int hx = 0, hy = 0;
    if (Native.GetIconInfo(ci.hCursor, out info)) {
      hx = info.xHotspot; hy = info.yHotspot;
      if (info.hbmMask != IntPtr.Zero) Native.DeleteObject(info.hbmMask);
      if (info.hbmColor != IntPtr.Zero) Native.DeleteObject(info.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try { Native.DrawIconEx(hdc, ci.pt.X - originX - hx, ci.pt.Y - originY - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
    finally { g.ReleaseHdc(hdc); }
  }

  static Dictionary<string, object> OverlayCmd(Dictionary<string, object> r) {
    bool show = BoolOr(r, "show", false);
    string text = Str(r, "text") ?? "A bot is using your PC";
    bool capturable = BoolOr(r, "capturable", false);
    ui.Invoke((MethodInvoker)delegate {
      foreach (Overlay o in overlays) { o.Close(); o.Dispose(); }
      overlays.Clear();
      if (!show) return;
      Color color = Color.FromArgb(255, 90, 31);
      foreach (Monitor m in Monitors()) {
        float scale = m.Dpi / 96f;
        int t = Math.Max(3, (int)Math.Round(4 * scale));
        Rectangle b = m.Bounds;
        overlays.Add(new Overlay(new Rectangle(b.X, b.Y, b.Width, t), color, false, null, 0, capturable));
        overlays.Add(new Overlay(new Rectangle(b.X, b.Bottom - t, b.Width, t), color, false, null, 0, capturable));
        overlays.Add(new Overlay(new Rectangle(b.X, b.Y + t, t, b.Height - 2 * t), color, false, null, 0, capturable));
        overlays.Add(new Overlay(new Rectangle(b.Right - t, b.Y + t, t, b.Height - 2 * t), color, false, null, 0, capturable));
        int lw = Math.Min(b.Width - 4 * t, (int)Math.Round(520 * scale));
        int lh = (int)Math.Round(30 * scale);
        overlays.Add(new Overlay(new Rectangle(b.X + (b.Width - lw) / 2, b.Y + t, lw, lh), color, true, text, 13 * scale, capturable));
      }
      foreach (Overlay o in overlays) o.Show();
    });
    armed = show;
    return Dict("shown", show);
  }

  static void SendMouse(uint flags, int data) {
    Native.INPUT[] input = new Native.INPUT[1];
    input[0].type = 0;
    input[0].u.mi.dwFlags = flags;
    input[0].u.mi.mouseData = data;
    input[0].u.mi.extra = injectTag;
    Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT)));
  }

  // Absolute move over the virtual desktop, then SetCursorPos to land on the
  // exact pixel: the 0..65535 normalisation can round one pixel off.
  static void MoveTo(int x, int y) {
    int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77);
    int vw = Native.GetSystemMetrics(78), vh = Native.GetSystemMetrics(79);
    Native.INPUT[] input = new Native.INPUT[1];
    input[0].type = 0;
    input[0].u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    input[0].u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    input[0].u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
    input[0].u.mi.extra = injectTag;
    Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT)));
    Native.POINT p;
    Native.GetCursorPos(out p);
    if (p.X != x || p.Y != y) Native.SetCursorPos(x, y);
  }

  static uint DownFlag(string button) { return button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u; }
  static uint UpFlag(string button) { return button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u; }

  static Dictionary<string, object> Click(Dictionary<string, object> r) {
    string button = Str(r, "button") ?? "left";
    int count = Math.Max(1, Math.Min(3, IntOr(r, "count", 1)));
    if (r.ContainsKey("x") && r["x"] != null) { MoveTo(Int(r, "x"), Int(r, "y")); Thread.Sleep(40); }
    int gap = (int)Math.Min(120, Native.GetDoubleClickTime() / 4);
    List<int> modifiers = new List<int>();
    if (r.ContainsKey("modifiers") && r["modifiers"] is ArrayList) {
      foreach (object vk in (ArrayList)r["modifiers"]) modifiers.Add(Convert.ToInt32(vk));
    }
    foreach (int vk in modifiers) { KeyVk(vk, true); Thread.Sleep(15); }
    try {
      for (int i = 0; i < count; i++) {
        SendMouse(DownFlag(button), 0);
        Thread.Sleep(25);
        SendMouse(UpFlag(button), 0);
        if (i + 1 < count) Thread.Sleep(gap);
      }
    } finally {
      for (int i = modifiers.Count - 1; i >= 0; i--) KeyVk(modifiers[i], false);
    }
    return Dict();
  }

  static Dictionary<string, object> ButtonCmd(Dictionary<string, object> r) {
    string button = Str(r, "button") ?? "left";
    bool down = BoolOr(r, "down", true);
    if (r.ContainsKey("x") && r["x"] != null) MoveTo(Int(r, "x"), Int(r, "y"));
    SendMouse(down ? DownFlag(button) : UpFlag(button), 0);
    return Dict();
  }

  static Dictionary<string, object> Drag(Dictionary<string, object> r) {
    int x1 = Int(r, "fromX"), y1 = Int(r, "fromY"), x2 = Int(r, "toX"), y2 = Int(r, "toY");
    string button = Str(r, "button") ?? "left";
    int gen = abortGeneration;
    long start = DateTime.UtcNow.Ticks;
    MoveTo(x1, y1);
    Thread.Sleep(60);
    SendMouse(DownFlag(button), 0);
    try {
      int steps = 24;
      for (int i = 1; i <= steps; i++) {
        CheckInterrupted(gen, start);
        MoveTo(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
        Thread.Sleep(15);
      }
      Thread.Sleep(60);
    } finally {
      SendMouse(UpFlag(button), 0);
    }
    return Dict();
  }

  static Dictionary<string, object> Scroll(Dictionary<string, object> r) {
    if (r.ContainsKey("x") && r["x"] != null) { MoveTo(Int(r, "x"), Int(r, "y")); Thread.Sleep(30); }
    int dy = IntOr(r, "dy", 0), dx = IntOr(r, "dx", 0);
    int gen = abortGeneration;
    long start = DateTime.UtcNow.Ticks;
    for (int i = 0; i < Math.Abs(dy); i++) { CheckInterrupted(gen, start); SendMouse(0x0800, dy > 0 ? -120 : 120); Thread.Sleep(20); }
    for (int i = 0; i < Math.Abs(dx); i++) { CheckInterrupted(gen, start); SendMouse(0x1000, dx > 0 ? 120 : -120); Thread.Sleep(20); }
    return Dict();
  }

  // Raw wheel deltas (120 = one notch) for the owner's smooth scrolling.
  // Browser convention in: dy > 0 scrolls down, dx > 0 scrolls right.
  static Dictionary<string, object> Wheel(Dictionary<string, object> r) {
    if (r.ContainsKey("x") && r["x"] != null) MoveTo(Int(r, "x"), Int(r, "y"));
    int dy = Math.Max(-2400, Math.Min(2400, IntOr(r, "dy", 0)));
    int dx = Math.Max(-2400, Math.Min(2400, IntOr(r, "dx", 0)));
    if (dy != 0) SendMouse(0x0800, -dy);
    if (dx != 0) SendMouse(0x1000, dx);
    return Dict();
  }

  static void SendKey(ushort vk, ushort scan, uint flags) {
    Native.INPUT[] input = new Native.INPUT[1];
    input[0].type = 1;
    input[0].u.ki.wVk = vk;
    input[0].u.ki.wScan = scan;
    input[0].u.ki.dwFlags = flags;
    input[0].u.ki.extra = injectTag;
    Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT)));
  }

  static bool IsExtended(int vk) {
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0x90: case 0xA3: case 0xA5: case 0x2C:
        return true;
    }
    return false;
  }

  static void KeyVk(int vk, bool down) {
    uint flags = (IsExtended(vk) ? 0x0001u : 0u) | (down ? 0u : 0x0002u);
    SendKey((ushort)vk, (ushort)Native.MapVirtualKey((uint)vk, 0), flags);
  }

  // Types one character as real key presses (virtual key + scan code) when the
  // active layout has a key for it with at most Shift. VirtualBox and other
  // apps that read scan codes ignore KEYEVENTF_UNICODE (VK_PACKET) input, so a
  // VM never saw typed text. Anything else (Ctrl/AltGr combos, emoji, other
  // scripts) returns false and falls back to Unicode input.
  static bool TypeCharAsKeys(char c) {
    short mapped = Native.VkKeyScan(c);
    if (mapped == -1) return false;
    int vk = mapped & 0xFF;
    int shiftState = (mapped >> 8) & 0xFF;
    if ((shiftState & ~1) != 0) return false;
    bool shift = (shiftState & 1) != 0;
    // Caps Lock flips letters; undo it so the character typed is the one asked for.
    bool letter = vk >= 0x41 && vk <= 0x5A;
    if (letter && (Native.GetKeyState(0x14) & 1) != 0) shift = !shift;
    if (shift) KeyVk(0x10, true);
    KeyVk(vk, true);
    KeyVk(vk, false);
    if (shift) KeyVk(0x10, false);
    return true;
  }

  // VirtualBox VMs ignore keyboard input injected with SendInput while their
  // window has focus, so keys aimed at a VM go through VirtualBox's own API
  // (VBoxManage controlvm <vm> keyboardputstring / keyboardputscancode).
  static readonly string VBoxManagePath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Oracle\VirtualBox\VBoxManage.exe");

  // The VM name when a VirtualBox VM window is in front ("<name> [Running] - Oracle VirtualBox"), else null.
  static string ForegroundVm() {
    if (!File.Exists(VBoxManagePath)) return null;
    IntPtr hwnd = Native.GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return null;
    uint pid;
    Native.GetWindowThreadProcessId(hwnd, out pid);
    try {
      string name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
      if (!string.Equals(name, "VirtualBoxVM", StringComparison.OrdinalIgnoreCase)) return null;
    } catch { return null; }
    StringBuilder title = new StringBuilder(512);
    Native.GetWindowText(hwnd, title, title.Capacity);
    string t = title.ToString();
    int cut = t.IndexOf(" [");
    return cut > 0 ? t.Substring(0, cut) : null;
  }

  static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  static void VBox(string vm, string verb, string args) {
    System.Diagnostics.ProcessStartInfo info = new System.Diagnostics.ProcessStartInfo(
      VBoxManagePath, "controlvm " + Quote(vm) + " " + verb + " " + args);
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardError = true;
    using (System.Diagnostics.Process p = System.Diagnostics.Process.Start(info)) {
      string err = p.StandardError.ReadToEnd();
      if (!p.WaitForExit(8000)) { try { p.Kill(); } catch { } throw new HelperError("vm_input", "The VM did not take the keys in time."); }
      if (p.ExitCode != 0) throw new HelperError("vm_input", "The VM refused the keys: " + err.Trim());
    }
  }

  static string ScanHex(int code) { return code.ToString("x2"); }

  // Press then release a list of virtual keys as PC/AT scan codes, e.g. win+r -> "e0 5b 13 93 e0 db".
  static string ScanCodesFor(List<int> vks) {
    List<string> codes = new List<string>();
    foreach (int vk in vks) {
      int sc = (int)Native.MapVirtualKey((uint)vk, 0);
      if (IsExtended(vk)) codes.Add("e0");
      codes.Add(ScanHex(sc));
    }
    for (int i = vks.Count - 1; i >= 0; i--) {
      int sc = (int)Native.MapVirtualKey((uint)vks[i], 0);
      if (IsExtended(vks[i])) codes.Add("e0");
      codes.Add(ScanHex(sc | 0x80));
    }
    return string.Join(" ", codes.ToArray());
  }

  static Dictionary<string, object> TypeTextInVm(string vm, string text) {
    int typed = 0;
    StringBuilder run = new StringBuilder();
    Action flush = delegate {
      if (run.Length > 0) { VBox(vm, "keyboardputstring", Quote(run.ToString())); run.Length = 0; }
    };
    foreach (char c in text) {
      if (c == '\r') { typed++; continue; }
      if (c == '\n' || c == '\t') {
        flush();
        VBox(vm, "keyboardputscancode", c == '\n' ? "1c 9c" : "0f 8f");
      } else {
        run.Append(c);
      }
      typed++;
    }
    flush();
    return Dict("typed", typed, "via", "vm");
  }

  static Dictionary<string, object> TypeText(Dictionary<string, object> r) {
    string text = Str(r, "text") ?? "";
    string vm = ForegroundVm();
    if (vm != null) return TypeTextInVm(vm, text);
    int delay = Math.Max(0, IntOr(r, "delayMs", 6));
    int gen = abortGeneration;
    long start = DateTime.UtcNow.Ticks;
    int typed = 0;
    for (int i = 0; i < text.Length; i++) {
      CheckInterrupted(gen, start);
      char c = text[i];
      if (c == '\r') { typed++; continue; }
      if (c == '\n') { KeyVk(0x0D, true); KeyVk(0x0D, false); }
      else if (c == '\t') { KeyVk(0x09, true); KeyVk(0x09, false); }
      else if (!TypeCharAsKeys(c)) {
        SendKey(0, c, 0x0004);
        SendKey(0, c, 0x0004 | 0x0002);
      }
      typed++;
      if (delay > 0) Thread.Sleep(delay);
    }
    return Dict("typed", typed);
  }

  // keys: [[vk, ...], ...] resolved by the server, or {"char": "/"} entries the
  // helper resolves against the active keyboard layout.
  static Dictionary<string, object> Keys(Dictionary<string, object> r) {
    ArrayList combos = (ArrayList)r["combos"];
    int repeat = Math.Max(1, Math.Min(50, IntOr(r, "repeat", 1)));
    int gen = abortGeneration;
    for (int n = 0; n < repeat; n++) {
      foreach (object comboObj in combos) {
        if (abortGeneration != gen) throw new HelperError("aborted", "Stopped by the user.");
        List<int> vks = new List<int>();
        foreach (object entry in (ArrayList)comboObj) {
          if (entry is Dictionary<string, object>) {
            string ch = Str((Dictionary<string, object>)entry, "char");
            if (string.IsNullOrEmpty(ch)) throw new HelperError("bad_key", "Empty key");
            short scan = Native.VkKeyScan(ch[0]);
            if (scan == -1) throw new HelperError("bad_key", "No key on this keyboard layout types '" + ch + "'.");
            int shiftState = (scan >> 8) & 0xFF;
            if ((shiftState & 1) != 0 && !vks.Contains(0x10)) vks.Insert(0, 0x10);
            if ((shiftState & 2) != 0 && !vks.Contains(0x11)) vks.Insert(0, 0x11);
            if ((shiftState & 4) != 0 && !vks.Contains(0x12)) vks.Insert(0, 0x12);
            vks.Add(scan & 0xFF);
          } else {
            vks.Add(Convert.ToInt32(entry));
          }
        }
        string vm = ForegroundVm();
        if (vm != null) {
          VBox(vm, "keyboardputscancode", ScanCodesFor(vks));
        } else {
          foreach (int vk in vks) { KeyVk(vk, true); Thread.Sleep(15); }
          for (int i = vks.Count - 1; i >= 0; i--) { KeyVk(vks[i], false); Thread.Sleep(10); }
        }
        Thread.Sleep(40);
      }
    }
    return Dict();
  }
}
`;
