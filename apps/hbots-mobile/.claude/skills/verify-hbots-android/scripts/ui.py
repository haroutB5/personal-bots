"""adb + uiautomator helpers for verify-hbots-android. Every read is one adb round trip."""
import hashlib
import os
import re
import selectors
import shlex
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


class Node:
    __slots__ = ("text", "desc", "rid", "cls", "clickable", "enabled", "box")

    def __init__(self, el):
        self.text = el.get("text", "")
        self.desc = el.get("content-desc", "")
        self.rid = el.get("resource-id", "")
        self.cls = el.get("class", "")
        self.clickable = el.get("clickable") == "true"
        self.enabled = el.get("enabled") == "true"
        m = BOUNDS.fullmatch(el.get("bounds", ""))
        self.box = tuple(int(v) for v in m.groups()) if m else (0, 0, 0, 0)

    @property
    def center(self):
        l, t, r, b = self.box
        return (l + r) // 2, (t + b) // 2

    def label(self):
        return self.text or self.desc or self.rid

    def __repr__(self):
        return f"<{self.cls.rsplit('.', 1)[-1]} text={self.text[:40]!r} desc={self.desc[:40]!r} id={self.rid!r} box={self.box}>"


class Screen:
    def __init__(self, nodes, width, height):
        self.nodes, self.width, self.height = nodes, width, height

    def drawn(self, n):
        l, t, r, b = n.box
        cx, cy = n.center
        return r > l and b > t and (r - l) > 2 and (b - t) > 2 and 0 <= cx < self.width and 0 <= cy < self.height

    def find(self, text=None, desc=None, rid=None, visible=True):
        def hit(pat, val):
            return pat is None or re.fullmatch(pat, val) is not None
        out = [n for n in self.nodes if hit(text, n.text) and hit(desc, n.desc) and hit(rid, n.rid)
               and (text is None or n.text) and (desc is None or n.desc) and (rid is None or n.rid)]
        return [n for n in out if self.drawn(n)] if visible else out

    def first(self, **kw):
        found = self.find(**kw)
        return found[0] if found else None

    def texts(self):
        return [n.text for n in self.nodes if n.text and self.drawn(n)]


HERE = os.path.dirname(os.path.abspath(__file__))
DUMPER_SRC = os.path.join(HERE, "uidump", "Dumper.java")
DUMPER_DEVICE = "/data/local/tmp/hbots-uidump.jar"
# The persistent dumper waits for this long a quiet screen before each dump (`uiautomator dump` waits 1000 ms).
DUMP_IDLE_MS = int(os.environ.get("VERIFY_DUMP_IDLE_MS", "300"))
DUMP_GLOBAL_MS = int(os.environ.get("VERIFY_DUMP_GLOBAL_MS", "3000"))


def build_dumper(cache_dir):
    """Compile uidump/Dumper.java to a dex jar once per source version (javac + d8 from the SDK). Returns the jar path or None."""
    src = open(DUMPER_SRC, "rb").read()
    out = os.path.join(cache_dir, f"hbots-uidump-{hashlib.sha256(src).hexdigest()[:12]}.zip")
    if os.path.exists(out):
        return out
    sdk = os.environ.get("ANDROID_HOME") or os.path.expanduser("~/Android/Sdk")
    java_home = os.environ.get("JAVA_HOME") or "/home/harout/.local/share/mise/installs/java/temurin-21"
    platforms = sorted(d for d in os.listdir(os.path.join(sdk, "platforms")) if d.startswith("android-"))
    tools = sorted(os.listdir(os.path.join(sdk, "build-tools")))
    javac = os.path.join(java_home, "bin", "javac")
    if not (platforms and tools and os.path.exists(javac)):
        return None
    work = os.path.join(cache_dir, "uidump-build")
    os.makedirs(work, exist_ok=True)
    env = dict(os.environ, JAVA_HOME=java_home)
    subprocess.run([javac, "--release", "11", "-nowarn", "-cp", os.path.join(sdk, "platforms", platforms[-1], "android.jar"), "-d", work, DUMPER_SRC],
                   check=True, capture_output=True, env=env, timeout=120)
    subprocess.run([os.path.join(sdk, "build-tools", tools[-1], "d8"), "--min-api", "30", "--output", out + ".tmp.zip", os.path.join(work, "Dumper.class")],
                   check=True, capture_output=True, env=env, timeout=120)
    shutil.move(out + ".tmp.zip", out)
    return out


class Device:
    def __init__(self, adb, log=None):
        self.adb = shlex.split(adb)
        self.log = log or (lambda *a: None)
        self.width, self.height = 1080, 2355
        self.anr_taps = 0
        # Where the driver's time goes, for the per-flow timing lines: {"dump"|"adb": [calls, seconds]}.
        self.stats = {"dump": [0, 0.0], "adb": [0, 0.0]}

    def run(self, *args, timeout=40, text=True, check=False):
        t0 = time.monotonic()
        try:
            r = subprocess.run(self.adb + list(args), capture_output=True, timeout=timeout)
        finally:
            kind = "dump" if args and args[0] == "exec-out" and "uiautomator dump" in str(args[1:2]) else "adb"
            self.stats[kind][0] += 1
            self.stats[kind][1] += time.monotonic() - t0
        out = r.stdout.decode("utf-8", "replace") if text else r.stdout
        if check and r.returncode:
            raise RuntimeError(f"adb {' '.join(args[:3])} failed: {r.stderr.decode('utf-8', 'replace')[:200]}")
        return out

    def sh(self, cmd, **kw):
        return self.run("shell", cmd, **kw)

    # ---- the persistent dumper (uidump/Dumper.java); `uiautomator dump` is the fallback ----
    dumper = None
    dumper_failures = 0
    dumper_cache = ""

    def start_dumper(self, cache_dir):
        """Push and start the persistent dumper. Returns a short status for the log. VERIFY_FAST_DUMP=0 keeps `uiautomator dump`."""
        self.dumper_cache = cache_dir
        if os.environ.get("VERIFY_FAST_DUMP", "1") == "0":
            return "off (VERIFY_FAST_DUMP=0), using uiautomator dump"
        try:
            jar = build_dumper(cache_dir)
            if not jar:
                return "no javac or SDK build tools, using uiautomator dump"
            self.run("push", jar, DUMPER_DEVICE, check=True)
            cmd = f"CLASSPATH=/system/framework/uiautomator.jar:{DUMPER_DEVICE} exec app_process /system/bin Dumper {DUMP_IDLE_MS} {DUMP_GLOBAL_MS}"
            p = subprocess.Popen(self.adb + ["shell", cmd], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.dumper = p
            first = self._dumper_read(15.0, until="READY")
            if first is None or "READY" not in first:
                self.stop_dumper()
                return f"did not start ({(first or 'no answer')[:80]!r}), using uiautomator dump"
            return f"persistent, idle {DUMP_IDLE_MS} ms"
        except Exception as e:
            self.stop_dumper()
            return f"failed to start ({type(e).__name__}: {str(e)[:80]}), using uiautomator dump"

    def stop_dumper(self):
        p, self.dumper = self.dumper, None
        if not p:
            return
        try:
            p.stdin.write(b"quit\n"); p.stdin.flush(); p.stdin.close()
            p.wait(timeout=5)
        except Exception:
            p.kill()
            try:
                p.wait(timeout=5)
            except Exception:
                pass

    def _dumper_read(self, timeout, until="END"):
        """Lines from the dumper up to the line `until`, or None on a timeout or exit."""
        p = self.dumper
        buf = b""
        end = time.monotonic() + timeout
        sel = selectors.DefaultSelector()
        sel.register(p.stdout, selectors.EVENT_READ)
        try:
            while True:
                left = end - time.monotonic()
                if left <= 0 or not sel.select(left):
                    return None
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk:
                    return None
                buf += chunk
                text = buf.decode("utf-8", "replace")
                if until == "READY" and "READY" in text:
                    return text
                if text.endswith(f"\n{until}\n") or text.endswith(f"\n{until}\r\n"):
                    return text[: text.rindex(until)]
        finally:
            sel.close()

    def dump_xml(self):
        """The raw dump XML: from the persistent dumper, else (and after any dumper failure) from `uiautomator dump`."""
        if self.dumper:
            t0 = time.monotonic()
            try:
                self.dumper.stdin.write(b"dump\n"); self.dumper.stdin.flush()
                text = self._dumper_read(DUMP_GLOBAL_MS / 1000 + 15)
            except Exception:
                text = None
            self.stats["dump"][0] += 1
            self.stats["dump"][1] += time.monotonic() - t0
            if text is not None and "<?xml" in text:
                return text
            # Stop it first: only one UiAutomation may be connected, and the fallback connects its own.
            self.dumper_failures += 1
            self.stop_dumper()
            again = self.dumper_failures < 3
            self.log(f"persistent dumper answered {'nothing' if text is None else repr(text.strip()[:80])}; this dump uses uiautomator dump"
                     + (", then the dumper restarts" if again else ", and so does every dump after it"))
            raw = self.run("exec-out", "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml")
            if again:
                self.log(f"persistent dumper restart: {self.start_dumper(self.dumper_cache)}")
            return raw
        return self.run("exec-out", "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml")

    def dump(self):
        raw = self.dump_xml()
        try:
            root = ET.fromstring(raw[raw.index("<?xml"):] if "<?xml" in raw else raw)
        except ET.ParseError:
            return Screen([], self.width, self.height)
        screen = Screen([Node(e) for e in root.iter("node")], self.width, self.height)
        box = screen.first(text="System UI isn't responding")
        wait = screen.first(text="Wait") if box else None
        if wait and self.anr_taps < 20:
            self.anr_taps += 1
            self.log(f"System UI isn't responding box dismissed ({self.anr_taps})")
            self.tap(wait)
            time.sleep(2.0)
            return self.dump()
        return screen

    def wait(self, pred, timeout=15.0, every=0.35):
        end = time.time() + timeout
        s = self.dump()
        while True:
            got = pred(s)
            if got:
                return s, got
            if time.time() > end:
                return s, None
            time.sleep(every)
            s = self.dump()

    def tap_xy(self, x, y):
        self.sh(f"input tap {x} {y}")

    def tap(self, node):
        self.tap_xy(*node.center)

    def swipe(self, x1, y1, x2, y2, ms=350):
        self.sh(f"input swipe {x1} {y1} {x2} {y2} {ms}")

    def key(self, code):
        self.sh(f"input keyevent {code}")

    def type(self, text, size=40, pause=0.0):
        for i in range(0, len(text), size):
            self.sh("input text " + shlex.quote(text[i:i + size].replace(" ", "%s")))
            if pause:
                time.sleep(pause)

    def shot(self, path):
        data = self.run("exec-out", "screencap", "-p", text=False)
        with open(path, "wb") as f:
            f.write(data)
