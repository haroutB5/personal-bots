"""adb + uiautomator helpers for verify-hbots-android. Every read is one adb round trip."""
import re
import shlex
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


class Device:
    def __init__(self, adb, log=None):
        self.adb = shlex.split(adb)
        self.log = log or (lambda *a: None)
        self.width, self.height = 1080, 2355
        self.anr_taps = 0

    def run(self, *args, timeout=40, text=True, check=False):
        r = subprocess.run(self.adb + list(args), capture_output=True, timeout=timeout)
        out = r.stdout.decode("utf-8", "replace") if text else r.stdout
        if check and r.returncode:
            raise RuntimeError(f"adb {' '.join(args[:3])} failed: {r.stderr.decode('utf-8', 'replace')[:200]}")
        return out

    def sh(self, cmd, **kw):
        return self.run("shell", cmd, **kw)

    def dump(self):
        raw = self.run("exec-out", "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml")
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
