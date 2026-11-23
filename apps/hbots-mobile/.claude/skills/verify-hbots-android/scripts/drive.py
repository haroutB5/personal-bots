#!/usr/bin/env python3
"""verify-hbots-android driver. python3 -I drive.py --apk A --adb "adb -P .. -s .." --evidence DIR --srv DIR --link-host URL [--only 1,2]
Exit 0 all flows PASS, 1 a flow FAILED, 2 setup failed or the link to the throwaway server was lost (no verdict)."""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Flow 10's timeout leg waits for the server's real 2-minute auto-decline. With the overlap on, the driver
# asks for that approval first, in the F10_TIMEOUT_BOT chat, and runs the fillers during the wait. A filler
# must not open that bot's chat, the Work tab (flows 4 and 8 show a needs-you bar), the Tasks tab (flow 5:
# no bot working) or the Bots list order (flow 14), or go to the background (flow 6: push).
F10_TIMEOUT_BOT = "Researcher"  # a Chats row from the start; its own flows (seed, 6, 8) run after the decline
F10_FILLERS = (1, 7, 9, 3, 2, 11, 13, 12)
# Seconds each filler takes with its reset (fast3, 23 Nov 2026); no filler starts that would end after this.
F10_TYPICAL = {1: 8, 7: 10, 9: 13, 3: 6, 2: 14, 11: 14, 13: 17, 12: 31}
F10_DECLINE_AT = 116
# The server declines 2 minutes after the request; the fake CLI logs the request and the answer with times.
F10_MIN_DECLINE = 119
sys.path.insert(0, HERE)
from ui import Device  # noqa: E402

PKG = "com.haroutb5.hbots"
LONG_PARAGRAPH = "The quarterly report shows revenue grew in every region, with the strongest gains in the north where the new warehouse opened in March. "
LONG_REPLY = " ".join(("Summary line for the long report.\n\n" + LONG_PARAGRAPH * 4 + "\n\n" + LONG_PARAGRAPH * 3 + "\n\nEnd of the long report.").split())
SLOW_SECONDS = 6
SLOW_BACKGROUND_SECONDS = 7
LATEQ_SECONDS = 4
CHAT_TABS = ("Chats", "Tasks", "Computer", "Files")
SEND_DESC = r"Send(?:,.*)?"  # online "Send", offline "Send, waits here until your laptop reconnects"
PAIR_ATTEMPTS = 3
PAIR_WAIT = 40
# What the app shows when the link to the laptop is gone. The Chats and Tasks screens show the banner from packages/personal-client/src/bots/offlineBanner.ts
# (offlineBannerText: "Laptop offline", "Laptop offline · last contact 5m ago", "Reconnecting to your laptop…"; offlineBannerHint: the line under it).
# A chat screen shows only the composer's own line, which starts "Offline." (its copy changes: "Offline. Messages you send now go out when the laptop is back."),
# so that line is matched by its stable "Offline." start and never by its full text.
OFFLINE_TEXT = (r"Laptop offline.*|Reconnecting to your laptop.*|Messages you send will go out when it reconnects\.|"
                r"\d+ messages? (?:is|are) waiting to send\..*|Offline\. .*")
# cloudflared lines that mean the tunnel itself dropped, at any log level: "ERR Serve tunnel error ... no recent network activity" and the
# "INF Retrying connection in up to 2s" that follows it. A flow that fails while one of these is new is a lost link, not an app verdict.
TUNNEL_LOG_DOWN = re.compile(r"(Serve tunnel error|no recent network activity|Retrying connection|Lost connection|connection with the edge|Unable to establish)", re.I)
# cloudflared lines about aborted requests. Some also appear on a normal client cancel, so these alone never decide: they need the Offline banner.
TUNNEL_LOG_BAD = re.compile(r"(Unable to reach the origin|failed to serve|Request failed|ended abruptly|stream canceled)", re.I)
# What the bot's prompt log line looks like around the text that was typed: the reply quote in front, the attached photos behind.
PROMPT_LINE = re.compile(r' prompt (".*")$')
REPLY_QUOTE = re.compile(r'^\[Replying to my earlier message: ".*?"\]\n\n', re.S)
ATTACHED = re.compile(r'(?:\n\n)?\[Attached image "[^"]*" is saved at: [^\]]*\]')


def prompt_text(line):
    """The text the bot was handed, from one fake-claude.log 'prompt "..."' line, with the reply quote and the attached-photo notes taken off."""
    m = PROMPT_LINE.search(line)
    if not m:
        return None
    try:
        text = json.loads(m.group(1))
    except ValueError:
        return None
    return ATTACHED.sub("", REPLY_QUOTE.sub("", text, count=1)).strip()


SLEPT = [0.0]  # seconds spent in time.sleep since start (counted only when main() installs counted_sleep)
_real_sleep = time.sleep


def counted_sleep(secs):
    SLEPT[0] += max(0.0, secs)
    _real_sleep(secs)


def split(a, b):
    """Where the wall time between two snapshots went: uiautomator dumps, other adb calls, sleeps, and the rest (host work: logs, curl, srv.mjs)."""
    wall = b[0] - a[0]
    dn, ds, an, as_, sl = (b[i] - a[i] for i in range(1, 6))
    return {"wall": round(wall, 1), "dumps": dn, "dump_s": round(ds, 1), "adb": an, "adb_s": round(as_, 1), "sleep_s": round(sl, 1),
            "host_s": round(wall - ds - as_ - sl, 1)}


def split_text(x):
    return f"{x['wall']:.1f} s = {x['dumps']} dumps {x['dump_s']:.1f} s + {x['adb']} adb {x['adb_s']:.1f} s + sleeps {x['sleep_s']:.1f} s + host {x['host_s']:.1f} s"


LOG_TIME = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z (\d+) ")


def decline_seconds(lines):
    """Seconds between the SAFETYQ prompt and the server's auto-decline of its approval, from the fake CLI's own log times:
    the last 'safety answered' line that carries the timeout advice, and the last SAFETYQ prompt of the same CLI before it.
    None when the log does not show both. The time the screen was read does not count: a card declined early and
    only looked at after 2 minutes must not pass."""
    stamp = lambda m: datetime.datetime.fromisoformat(m.group(1) + "+00:00").timestamp()
    for i in range(len(lines) - 1, -1, -1):
        m = LOG_TIME.match(lines[i])
        if not (m and " safety answered " in lines[i] and "No one answered this approval" in lines[i]):
            continue
        for j in range(i - 1, -1, -1):
            a = LOG_TIME.match(lines[j])
            if a and a.group(2) == m.group(2) and prompt_text(lines[j]) == "SAFETYQ":
                return stamp(m) - stamp(a)
        return None
    return None


def field_is_draft(field, text):
    return bool(field and text in field.text)


class Run:
    def __init__(self, a):
        self.a = a
        self.ev = a.evidence
        os.makedirs(f"{self.ev}/shots", exist_ok=True)
        self.d = Device(a.adb, self.note)
        self.t0 = time.time()
        self.results = []
        self.timing = {}
        self.srvlog = f"{a.srv}/server.log"
        self.fakelog = f"{a.srv}/fake-pids/fake-claude.log"
        self.h = {}
        self.setup_reason = ""
        self.tlog_pos = os.path.getsize(a.tunnel_log) if a.tunnel_log and os.path.exists(a.tunnel_log) else 0

    def snap(self):
        st = self.d.stats
        return (time.monotonic(), st["dump"][0], st["dump"][1], st["adb"][0], st["adb"][1], SLEPT[0])

    def note(self, msg):
        line = f"{time.strftime('%H:%M:%S', time.gmtime())} {msg}"
        print(line, flush=True)
        if not os.environ.get("VERIFY_STDOUT_TEED"):  # verify.sh tees this stdout into run.log itself: writing it here too doubled every line
            with open(f"{self.ev}/run.log", "a") as f:
                f.write(line + "\n")

    def shot(self, name):
        self.d.shot(f"{self.ev}/shots/{name}.png")

    def srv(self, *args):
        env = dict(os.environ)
        r = subprocess.run(["node", f"{HERE}/srv.mjs", *args], capture_output=True, text=True, env=env)
        if r.returncode:
            raise RuntimeError(f"srv.mjs {args[0]}: {r.stderr.strip()[:200]}")
        return r.stdout.strip()

    def mark(self):
        return os.path.getsize(self.srvlog)

    def paths_since(self, mark):
        with open(self.srvlog, "rb") as f:
            f.seek(mark)
            text = f.read().decode("utf-8", "replace")
        return re.findall(r"personal notification path[\s\S]*?path: '([a-z-]+)'", text)

    def fake_lines(self):
        try:
            with open(self.fakelog) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def result(self, flow, name, verdict, reason, secs):
        self.results.append((flow, name, verdict, reason, secs))
        with open(f"{self.ev}/results.tsv", "a") as f:
            f.write(f"{flow}\t{name}\t{verdict}\t{secs:.0f}\t{reason}\n")
        self.note(f"flow {flow} {name} {verdict} ({secs:.0f} s): {reason}")

    def tabs_visible(self, s):
        return bool(s.first(desc="Chats") and s.first(desc="Tasks"))

    def tabs_text_visible(self, s):
        return bool(s.first(text="Chats") and s.first(text="Tasks") and s.first(text="Computer") and s.first(text="Files"))

    def long_press(self, node, ms=900):
        x, y = node.center
        self.d.swipe(x, y, x, y, ms)

    def reply_bar(self, s):
        """The composer's reply bar as the user reads it: (Cancel reply button, [visible texts inside the bar's rows])."""
        bar = next((x for x in s.find(desc="Cancel reply") if x.clickable), None)
        if not bar:
            return None, []
        top, bottom = bar.box[1] - 40, bar.box[3] + 40
        return bar, [n.text for n in s.nodes if n.text and s.drawn(n) and n.box[1] >= top and n.box[3] <= bottom and n.box[2] <= bar.box[0] + 10]

    def learn(self, s):
        for name in CHAT_TABS:
            n = next((x for x in s.find(desc=name) if x.clickable), None)
            if n:
                self.h[name] = n.center
        for key, kw in (("back", {"desc": "Back"}), ("plus", {"rid": "composer-plus"}), ("send", {"desc": SEND_DESC}), ("attach-add", {"rid": "attach-add"})):
            n = next((x for x in s.find(**kw) if x.clickable), None)
            if n:
                self.h[key] = n.center
        field = next((x for x in s.find(desc=r"Message .*…") if x.cls.endswith("EditText")), None)
        if field:
            self.h["field"] = field.center

    def tab(self, name):
        self.ensure_app()
        if name not in self.h:
            s, ok = self.d.wait(lambda s: self.tabs_visible(s), 10)
            if not ok:
                raise AssertionError(f"tab {name} not visible")
            self.learn(s)
        self.d.tap_xy(*self.h[name])
        time.sleep(0.9)

    def dismiss(self, s=None):
        s = s or self.d.dump()
        for label in ("Not now", "Don.t allow", "Allow"):
            n = s.first(text=label)
            if n:
                self.d.tap(n)
                time.sleep(0.5)

    def to_chats(self):
        for _ in range(4):
            self.ensure_app()
            s = self.d.dump()
            if self.tabs_visible(s):
                self.learn(s)
                break
            self.dismiss(s)
            self.d.key(4)
            time.sleep(0.6)
        self.tab("Chats")

    def composer_field(self, s):
        return next((x for x in s.find(desc=r"Message .*…") if x.cls.endswith("EditText")), None)

    def ensure_app(self):
        """The app must be in front before any tap. A Back at the Chats root, or a crash, leaves the launcher in front, and a tap there opens
        other apps (seen: Google Search). Relaunch the app and say so."""
        out = self.d.sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")
        if out.strip() and PKG not in out:
            self.note(f"the app was not in front ({out.strip().splitlines()[0].strip()[:90]}), relaunched")
            self.d.sh(f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1")
            time.sleep(2.5)
            return True
        return False

    def clear_composer(self, s):
        """Empty the composer of the chat in front: remove tray photos and delete draft text. A draft survives leaving a chat (it is saved per chat,
        and an app crash plus relaunch restores it), so every flow clears it where it types. Returns the screen after clearing."""
        cleaned = []
        for _ in range(8):
            tray = next((x for x in s.find(desc=r"Remove .*, \d+ of \d+") if x.clickable), None)
            field = self.composer_field(s)
            # uiautomator reports the hint ("Message Developer…") as the text of an empty field, so only other text is a draft
            has_text = bool(field and field.text.strip() and field.text != field.desc and not re.fullmatch(r"Message .*…", field.text))
            if tray:
                cleaned.append("photo tray"); self.d.tap(tray); time.sleep(0.5)
            elif has_text:
                cleaned.append("draft text"); self.d.tap(field); time.sleep(0.3)
                self.d.sh("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A"); self.d.key(67); self.d.key(111); time.sleep(0.4)
            else:
                break
            s = self.d.dump()
        else:
            raise AssertionError(f"could not empty the composer ({', '.join(cleaned)})")
        if cleaned:
            self.note(f"composer cleared on open: {', '.join(sorted(set(cleaned)))}")
        return s

    def reset(self):
        """Back to a known screen before every flow: close any menu, sheet or reply bar, drop leftover photos and draft text, then show the Chats tab.
        A flow that failed halfway (flow 9 with its reply bar open) must not turn the next flow red."""
        cleaned = []
        for _ in range(10):
            self.ensure_app()
            s = self.d.dump()
            self.dismiss(s)
            bar = next((x for x in s.find(desc="Cancel reply") if x.clickable), None)
            overlay = s.first(text="Copy text") or s.first(rid="attach-camera") or s.first(rid="attach-photos") or s.first(text=r"Add \d+ photos?")
            tray = next((x for x in s.find(desc=r"Remove .*, \d+ of \d+") if x.clickable), None)
            field = self.composer_field(s)
            if overlay:
                cleaned.append("menu or sheet"); self.d.key(4); time.sleep(0.6); continue
            if bar:
                cleaned.append("reply bar"); self.d.tap(bar); time.sleep(0.5); continue
            if tray:
                cleaned.append("photo tray"); self.d.tap(tray); time.sleep(0.5); continue
            # uiautomator reports the hint ("Message Developer…") as the text of an empty field, so only other text is a draft
            if field and field.text.strip() and field.text != field.desc and not re.fullmatch(r"Message .*…", field.text):
                cleaned.append("draft text"); self.d.tap(field); time.sleep(0.3)
                self.d.sh("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A"); self.d.key(67); self.d.key(111); time.sleep(0.4); continue
            if self.tabs_visible(s):
                break
            self.d.key(4); time.sleep(0.6)
        self.to_chats()
        if cleaned:
            self.note(f"reset: closed {', '.join(cleaned)}")

    def tunnel_log_new(self):
        """New cloudflared lines since the last look, as (down, aborted): `down` the lines that say the tunnel dropped (at any level),
        `aborted` the ERR/WRN lines about aborted requests."""
        path = self.a.tunnel_log
        if not path or not os.path.exists(path):
            return [], []
        with open(path, "rb") as f:
            f.seek(self.tlog_pos)
            text = f.read().decode("utf-8", "replace")
            self.tlog_pos = f.tell()
        lines = text.splitlines()
        return ([l for l in lines if TUNNEL_LOG_DOWN.search(l)],
                [l for l in lines if re.search(r"\b(ERR|WRN)\b", l) and TUNNEL_LOG_BAD.search(l)])

    def public_url_status(self):
        """http status of the throwaway server's environment route through the public tunnel URL, name resolved over 1.1.1.1 https. Never printed."""
        r = subprocess.run(["curl", "-s", "--doh-url", "https://1.1.1.1/dns-query", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6",
                            f"{self.a.link_host}/.well-known/t3/environment"], capture_output=True, text=True)
        return r.stdout.strip() or "none"

    def offline_banner(self, s):
        return next((n.text for n in s.nodes if n.text and s.drawn(n) and re.fullmatch(OFFLINE_TEXT, n.text)), None)

    def link_problem(self, full=False):
        """Why the link to the throwaway server looks lost, or None. Signals: the tunnel unit is gone, the public URL does not answer twice
        in a row, and (only with full, right after a flow failed) any of: cloudflared logged a serve error or a retry since the last look;
        the screen shows 'Not sent' together with the Offline banner; the Offline banner together with aborted-request lines."""
        unit = self.a.tunnel_unit
        if unit and subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit]).returncode != 0:
            return f"the tunnel unit {unit} is not running"
        down, aborted = self.tunnel_log_new()
        code = self.public_url_status()
        if code != "200":
            time.sleep(3)
            code = self.public_url_status()
            if code != "200":
                return f"the public tunnel URL does not answer (http {code}); cloudflared logged {len(down) + len(aborted)} problem line(s)"
        if not full:
            return None
        if not down:
            # cloudflared writes its serve error a moment after the link comes back: look once more before ruling it out
            time.sleep(3)
            more_down, more_aborted = self.tunnel_log_new()
            down, aborted = down + more_down, aborted + more_aborted
        if down:
            return f"cloudflared logged {len(down)} dropped-tunnel line(s) during the flow: {down[-1][-110:]!r}"
        try:
            s = self.d.dump()
        except Exception:
            return None
        banner = self.offline_banner(s)
        if banner and s.first(text=r"Not sent.*"):
            return f"the app shows 'Not sent' and its Offline banner ({banner[:40]!r})"
        if banner and aborted:
            return f"the app shows its Offline banner ({banner[:40]!r}) and cloudflared logged {len(aborted)} aborted request line(s): {aborted[-1][-100:]!r}"
        return None

    def bot_row(self, s, bot):
        return next((n for n in s.find(desc=rf"{bot}, .*") if n.clickable), None)

    def open_bot(self, bot):
        """Open the bot's chat. Two tries: a failed first try saves a dump and logcat (open-<bot>-<n>-*), resets the screen and goes again."""
        for attempt in (1, 2):
            try:
                return self.open_bot_once(bot)
            except AssertionError as e:
                self.note(f"opening {bot} failed on try {attempt}: {e}")
                self.save_diag(f"open-{bot}-{attempt}")
                if attempt == 2:
                    raise
                self.reset()

    def open_bot_once(self, bot):
        self.to_chats()
        s, row = self.d.wait(lambda s: self.bot_row(s, bot), 10)
        if not row:
            raise AssertionError(f"no {bot} row on the Chats tab")
        self.d.tap(row)
        time.sleep(1.0)
        # A bot with no chat shows "Start chat". That can open the "New chat with <bot>" sheet, whose own "Start chat" button is a second tap.
        # The sheet's name field has autofocus, so a stray character in it (seen once, an "M") is cleared first.
        for _ in range(3):
            s, n = self.d.wait(lambda s: s.first(desc=r"Message .*…") or s.first(text="Start chat"), 10)
            if not (n and n.text == "Start chat"):
                break
            field = next((x for x in s.nodes if x.cls.endswith("EditText") and s.drawn(x)), None)
            if s.first(text=r"New chat with .*") and field and field.text.strip() and field.desc != field.text and field.text != "Name (optional)":
                self.note(f"the New chat sheet name field held {field.text[:12]!r}, cleared")
                self.d.tap(field)
                self.d.sh("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A")
                self.d.key(67)
                time.sleep(0.3)
            self.d.tap(n)
            time.sleep(1.2)
        else:
            s, n = self.d.wait(lambda s: s.first(desc=r"Message .*…"), 10)
        if not n or n.text == "Start chat":
            raise AssertionError(f"{bot} chat did not open (no composer)")
        s = self.clear_composer(s)
        self.learn(s)
        return s

    def received(self, before, text):
        """The first prompt line since `before` whose text, once the reply quote and attached-photo notes are taken off, equals `text`. None if none does."""
        return next((l for l in self.fake_lines()[before:] if prompt_text(l) == text), None)

    def say(self, bot, text, expect=True):
        """Type `text`, tap Send, and (expect) wait until the bot was handed exactly `text`. A prompt that merely contains it is a failure:
        a draft left in the composer turns 'SLOW6' into 'PLANTDRASLOW6FT', and that must not pass. Returns the bot's prompt log line."""
        before = len(self.fake_lines())
        self.d.tap_xy(*self.h["field"])
        time.sleep(0.3)
        self.d.type(text)
        self.d.key(111)
        time.sleep(0.4)
        self.d.tap_xy(*self.h["send"])
        if not expect:
            return None
        retried = False
        for i in range(30):
            line = self.received(before, text)
            if line:
                return line
            if i == 10 and not retried:
                # 3 s on and the bot has nothing: if the text is still sitting in the composer the Send tap did not fire (seen once in
                # 9 runs, the tap landing while the keyboard was still closing). Tap once more and say so in the log.
                field = self.composer_field(self.d.dump())
                if field and text in field.text:
                    retried = True
                    self.note(f"send tap did not fire for {text!r}, tapping Send again")
                    self.d.tap_xy(*self.h["send"])
            time.sleep(0.3)
        got = [prompt_text(l) for l in self.fake_lines()[before:] if prompt_text(l) is not None]
        if got:
            raise AssertionError(f"the bot received {got[-1][:60]!r}, the flow sent {text!r} (not an exact match)")
        raise AssertionError(f"the bot never received {text!r}")

    def leave_chat(self):
        self.d.tap_xy(*self.h["back"])
        time.sleep(0.8)

    def setup(self):
        d, a = self.d, self.a
        self.h = {}
        self.note(f"apk {os.path.basename(a.apk)} sha256 {subprocess.run(['sha256sum', a.apk], capture_output=True, text=True).stdout[:16]}")
        if d.run("get-state").strip() != "device":
            raise RuntimeError("device not reachable")
        size = re.search(r"(\d+)x(\d+)", d.sh("wm size"))
        d.width, d.height = int(size.group(1)), int(size.group(2))
        d.run("uninstall", PKG)
        d.run("install", "-r", a.apk, check=True, timeout=180)
        # Harout's guard 3 (22 Nov 2026): app data cleared before each QA run, also when the emulator came from a
        # snapshot. Then the permission preset, granted after the clear.
        d.sh(f"pm clear {PKG}")
        d.sh(f"pm grant {PKG} android.permission.POST_NOTIFICATIONS")
        d.sh("cmd uimode night yes")
        d.sh("rm -f /sdcard/Pictures/verify-*.png")
        for name, tag in (("daily-red.png", "red"), ("daily-green.png", "green"), ("daily-blue.png", "blue")):
            d.run("push", f"{HERE}/photos/{name}", f"/sdcard/Pictures/verify-{tag}.png", check=True)
            d.sh(f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/verify-{tag}.png")
        d.run("logcat", "-c")
        self.note(f"screen dumps: {d.start_dumper(os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'hbots-verify-uidump'))}")
        d.sh(f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1")
        self.pair()
        self.srv("fakepush", a.srv)
        s, n = d.wait(lambda s: self.bot_row(s, "Developer"), 30)
        if not n:
            self.shot("setup-no-bots")
            raise RuntimeError("bots list empty after pairing")
        self.learn(s)
        self.version = next((t for t in s.texts() if re.fullmatch(r"v1\.\d+\.\d+.*", t)), "version not shown")
        self.note(f"paired, app shows {self.version}, setup {time.time() - self.t0:.0f} s")

    def redact(self, text, link=""):
        if link:
            text = text.replace(link, "<link>")
        text = re.sub(r"https?://[^\s\"'<>]+/pair[^\s\"'<>]*", "<link>", text)
        return re.sub(r"(token=)[A-Za-z0-9_\-]+", r"\1<token>", text)

    def save_diag(self, tag, link=""):
        """A screen dump and the logcat, with the pairing link and token blanked, so a setup failure can be diagnosed afterwards."""
        try:
            raw = self.d.dump_xml()
            with open(f"{self.ev}/{tag}-dump.xml", "w") as f:
                f.write(self.redact(raw, link))
        except Exception as e:
            self.note(f"{tag}: dump failed: {type(e).__name__}")
        try:
            with open(f"{self.ev}/{tag}-logcat.txt", "w") as f:
                f.write(self.redact(self.d.run("logcat", "-d", timeout=60), link))
        except Exception as e:
            self.note(f"{tag}: logcat failed: {type(e).__name__}")
        try:
            self.shot(tag)
        except Exception:
            pass

    def pair_once(self, link):
        d = self.d
        s, n = d.wait(lambda s: s.first(text="Paste a link instead"), 40)
        if not n:
            return "no pairing screen"
        d.tap(n)
        s, field = d.wait(lambda s: next((x for x in s.nodes if x.cls.endswith("EditText")), None), 10)
        if not field:
            return "no link field"
        d.tap(field)
        time.sleep(0.4)
        got = ""
        for size, pause in ((40, 0.0), (16, 0.2), (8, 0.4)):
            d.sh("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A")
            d.key(67)
            d.type(link, size, pause)
            s = d.dump()
            got = next((x.text for x in s.nodes if x.cls.endswith("EditText")), "")
            if got == link:
                break
        if got != link:
            return f"link field mismatch len={len(got)} want={len(link)} after 3 typing tries"
        d.key(111)
        time.sleep(0.4)
        s, cont = d.wait(lambda s: next((x for x in s.find(desc="Continue") if x.clickable), None), 5)
        if not cont:
            return "no Continue button"
        d.tap(cont)
        end = time.time() + PAIR_WAIT
        while time.time() < end:
            s = d.dump()
            if self.tabs_visible(s):
                return None
            if s.first(text=r"Can.t reach your laptop"):
                return "the app shows \"Can't reach your laptop\""
            for label in ("Allow", "It matches", "Pair", "Not now", "Skip"):
                n = s.first(text=label)
                if n:
                    d.tap(n)
                    time.sleep(0.8)
                    break
        return f"not paired in {PAIR_WAIT} s"

    def pair(self):
        """Up to PAIR_ATTEMPTS tries, each with a fresh pairing link and a freshly started app. A failed try saves a dump and logcat."""
        why = "no attempt"
        for attempt in range(1, PAIR_ATTEMPTS + 1):
            link = self.srv("pair", self.a.srv)
            link = re.sub(r"^http://127\.0\.0\.1:\d+", self.a.link_host, link)
            why = self.pair_once(link)
            if why is None:
                if attempt > 1:
                    self.note(f"paired on attempt {attempt}")
                return
            self.note(f"pairing attempt {attempt} of {PAIR_ATTEMPTS} failed: {why}")
            self.save_diag(f"pair-fail-{attempt}", link)
            if attempt < PAIR_ATTEMPTS:
                self.d.sh(f"am force-stop {PKG}")
                time.sleep(1.0)
                self.d.sh(f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1")
                time.sleep(2.0)
        raise RuntimeError(f"not paired after {PAIR_ATTEMPTS} attempts, last: {why}")

    def f1(self):
        self.open_bot("Developer")
        self.say("Developer", "hello_verify")
        time.sleep(1.2)
        self.dismiss()
        s, ok = self.d.wait(lambda s: s.first(text=r"Got it\.") and s.first(text=r"Idle .*"), 15)
        self.shot("f1-reply")
        if not s.first(text="hello_verify"):
            return "FAIL", "the sent text hello_verify is not visible in the chat"
        if not s.first(text=r"Got it\."):
            return "FAIL", "reply 'Got it.' never appeared as visible text"
        if not s.first(text=r"Idle .*"):
            return "FAIL", "chat status never returned to Idle"
        if s.first(desc="Stop") or s.first(text="Stop"):
            return "FAIL", "Stop button still showing after the reply"
        return "PASS", "sent text and reply 'Got it.' visible, status Idle, no Stop button, bot got prompt hello_verify"

    def f7(self):
        self.open_bot("Developer")
        self.say("Developer", "LONGMSG")
        time.sleep(2.0)
        s, got = self.d.wait(lambda s: s.first(text=r"End of the long report\."), 20)
        if not got:
            self.shot("f7-fail")
            return "FAIL", "the long reply never appeared as visible text (its last line 'End of the long report.')"
        y = min(max(got.center[1], 500), 1600)
        self.d.swipe(100, y, 460, y, 400)
        time.sleep(0.8)
        s, bar = self.d.wait(lambda s: next((x for x in s.find(desc="Cancel reply") if x.clickable), None), 4)
        self.shot("f7-quote")
        if not bar:
            return "FAIL", "swipe right on the reply opened no reply bar"
        quotes = [n.text for n in s.nodes if n.text.startswith("Summary line") and s.drawn(n) and n.box[1] > 1500]
        q = quotes[-1] if quotes else ""
        body = q[:-1] if q.endswith("…") else q
        ok = len(q) >= 280 and LONG_REPLY.startswith(body) and q.endswith("…")
        self.d.tap(bar)
        time.sleep(0.4)
        if not ok:
            return "FAIL", f"reply bar quote is {len(q)} chars, prefix_match={LONG_REPLY.startswith(body)}: {q[:50]!r}"
        return "PASS", f"reply bar quotes the reply excerpt ({len(q)} chars, a prefix of the full {len(LONG_REPLY)})"

    def long_press_reply(self, s, target, who, excerpt_ok, what):
        """Long press `target`, expect the message menu, tap Reply, expect the reply bar to quote it. Returns (None, texts) or (reason, texts)."""
        self.long_press(target)
        s, menu = self.d.wait(lambda s: s.first(text="Copy text") and next((x for x in s.find(desc="Reply") if x.clickable), None), 5)
        self.shot(f"f9-menu-{what}")
        if not menu:
            return f"long press on {what} opened no message menu (no Reply and Copy text)", []
        self.d.tap(menu)
        time.sleep(0.8)
        s, bar = self.d.wait(lambda s: next((x for x in s.find(desc="Cancel reply") if x.clickable), None), 4)
        self.shot(f"f9-reply-{what}")
        if s.first(text="Copy text"):
            return f"the message menu stayed open after Reply on {what}", []
        if not bar:
            return f"Reply in the long-press menu on {what} opened no reply bar", []
        bar, texts = self.reply_bar(s)
        if who not in texts:
            return f"reply bar on {what} does not name {who!r} (shows {texts})", texts
        if not any(excerpt_ok(t) for t in texts):
            return f"reply bar on {what} does not quote the message (shows {texts})", texts
        return None, texts

    def f9(self):
        self.open_bot("Developer")
        self.say("Developer", "LPRESS")
        s, ok = self.d.wait(lambda s: s.first(text=r"Idle .*") and next((x for x in s.find(desc="LPRESS") if x.clickable), None), 15)
        bubble = next((x for x in s.find(desc="LPRESS") if x.clickable), None)
        if not bubble or not s.first(text="LPRESS"):
            return "FAIL", "the sent message 'LPRESS' is not visible as a bubble"
        why, _ = self.long_press_reply(s, bubble, "You", lambda t: t == "LPRESS", "the sent message")
        if why:
            return "FAIL", why
        line = self.say("Developer", "LPQ")
        if "Replying to my earlier message" not in line or "LPRESS" not in line:
            return "FAIL", f"the bot received the reply without the quote of 'LPRESS': {line[-90:]!r}"
        s, echo = self.d.wait(lambda s: next((n for n in s.nodes if n.text.startswith("Got it.\nI received this quote with your message") and s.drawn(n)), None), 15)
        if not echo:
            return "FAIL", "the bot's answer that echoes the quote never appeared as visible text"
        why, _ = self.long_press_reply(s, echo, "Developer", lambda t: t.startswith("Got it.") and "I received this quote" in t, "the bot reply")
        if why:
            return "FAIL", why
        s = self.d.dump()
        bar = next((x for x in s.find(desc="Cancel reply") if x.clickable), None)
        self.d.tap(bar)
        time.sleep(0.5)
        if next((x for x in self.d.dump().find(desc="Cancel reply") if x.clickable), None):
            return "FAIL", "Cancel reply did not close the reply bar"
        return "PASS", "long press on the sent 'LPRESS' and on the bot reply opened the menu, Reply showed the right name and text in the composer, the bot received the quote"

    def f3(self):
        s = self.open_bot("Developer")
        self.learn(s)
        plus = next((n for n in s.find(rid="composer-plus")), None)
        if not plus:
            return "FAIL", "no plus button in the composer"
        row = [n for n in s.nodes if s.drawn(n) and n.clickable and n.center[1] > 2100]
        labels = sorted(n.label() for n in row)
        known = {"Add photos", "Attach files", "Send"}
        field = [n for n in row if n.cls.endswith("EditText")]
        others = [n for n in row if n.label() not in known and n not in field]
        self.shot("f3-composer")
        self.d.tap_xy(*self.h["plus"])
        time.sleep(1.2)
        s, sheet = self.d.wait(lambda s: s.first(rid="attach-camera"), 6)
        self.shot("f3-plus-sheet")
        camera_text = [n for n in s.find(text="Camera")]
        camera_btn = [n for n in s.find(rid="attach-camera")]
        if others:
            return "FAIL", f"unexpected control in the composer row: {others[0]!r} (row: {labels})"
        if len(camera_text) != 1 or len(camera_btn) != 1:
            return "FAIL", f"plus sheet shows 'Camera' {len(camera_text)} times and {len(camera_btn)} camera buttons (want 1 and 1)"
        return "PASS", f"composer row holds only {labels}, plus sheet shows 'Camera' once"

    def f2(self):
        self.open_bot("Developer")
        self.d.tap_xy(*self.h["plus"])
        time.sleep(1.2)
        s, _ = self.d.wait(lambda s: s.first(rid="attach-photos"), 6)
        grid = s.first(rid="attach-photos")
        if not grid:
            self.shot("f2-fail")
            return "FAIL", "plus sheet has no photo grid"
        l, t, r, b = grid.box
        w = (r - l) // 3
        y = t + w // 2
        for k in range(3):
            self.d.tap_xy(l + w * k + w // 2, y)
            time.sleep(0.6)
        s, add = self.d.wait(lambda s: s.first(text="Add 3 photos"), 4)
        self.shot("f2-picked")
        if not add:
            return "FAIL", "after tapping three photos the visible button is not 'Add 3 photos'"
        self.d.tap(add)
        time.sleep(1.2)
        s = self.d.dump()
        previews = sorted({n.desc for n in s.find(desc=r"Preview .*")})
        self.shot("f2-tray")
        line = self.say("Developer", "PHOTOS3")
        files = re.findall(r'Attached image \\"[^"]+?\\" is saved at: ([^\]]+?)\]', line)
        got = len(files)
        digests = set()
        for f in files:
            try:
                digests.add(subprocess.run(["sha256sum", f.strip()], capture_output=True, text=True).stdout.split()[0])
            except Exception:
                pass
        want = {subprocess.run(["sha256sum", f"{HERE}/photos/{n}"], capture_output=True, text=True).stdout.split()[0] for n in ("daily-red.png", "daily-green.png", "daily-blue.png")}
        time.sleep(1.5)
        s = self.d.dump()
        thumbs = sorted({n.desc for n in s.nodes if n.cls.endswith("ImageButton") and re.fullmatch(r".*\.(png|jpg)", n.desc) and s.drawn(n)})
        self.shot("f2-sent")
        if len(previews) != 3 or got != 3:
            return "FAIL", f"tray showed {len(previews)} photos (want 3), the bot got {got} attached images (want 3)"
        if len(thumbs) != 3:
            return "FAIL", f"the sent message shows {len(thumbs)} distinct images (want 3)"
        if digests != want:
            return "FAIL", f"the 3 files the bot received are not the 3 different photos picked ({len(digests & want)} of 3 match)"
        return "PASS", "tray showed 3 photos, the sent message shows 3 images, the bot got the 3 distinct picked files"

    # ---- probe: what the app does with a draft of text plus photos while the link is gone (N3). Not a verification flow. ----
    def attach_three(self):
        self.d.tap_xy(*self.h["plus"])
        time.sleep(1.2)
        s, _ = self.d.wait(lambda s: s.first(rid="attach-photos"), 6)
        l, t, r, b = s.first(rid="attach-photos").box
        w = (r - l) // 3
        for k in range(3):
            self.d.tap_xy(l + w * k + w // 2, t + w // 2)
            time.sleep(0.6)
        s, add = self.d.wait(lambda s: s.first(text="Add 3 photos"), 4)
        self.d.tap(add)
        time.sleep(1.2)

    def draft_state(self, tag, text):
        """What the user sees: composer text, photos in the tray, the Offline line, a bubble with the text, the queued state of the send."""
        s = self.d.dump()
        field = self.composer_field(s)
        previews = len({n.desc for n in s.find(desc=r"Preview .*")})
        offline = bool(self.offline_banner(s))
        bubble = bool(s.first(text=text) or s.first(desc=text))
        scrolled = 0
        while not bubble and scrolled < 4 and not field_is_draft(field, text):
            # a long sent message (text plus three tall photos) can sit above the top of the screen: scroll the chat up to read its text
            self.d.swipe(540, 700, 540, 1700, 300)
            time.sleep(0.8)
            scrolled += 1
            s2 = self.d.dump()
            bubble = bool(s2.first(text=text) or s2.first(desc=text))
            if bubble:
                s = s2
        thumbs = len({n.desc for n in s.nodes if n.cls.endswith("ImageButton") and re.fullmatch(r".*\.(png|jpg)", n.desc) and s.drawn(n)})
        waiting = [n.text for n in s.nodes if n.text and s.drawn(n) and re.search(r"(?i)waiting|queued|sending|will send|not sent|failed", n.text)][:3]
        self.shot(f"probe-{tag}")
        return f"[{tag}] scrolled {scrolled}x; composer text={field.text if field else None!r} tray photos={previews} sent-thumbnails={thumbs} bubble with text={bubble} offline notice={offline} status texts={waiting}"

    def tap_live_send(self):
        """Tap the Send button where it is now. Offline the composer's notice line pushes the row up, so the cached online position misses, and the
        node's label changes to 'Send, waits here until your laptop reconnects'. Find it by a description that starts with 'Send'."""
        s, node = self.d.wait(lambda s: next((x for x in s.find(desc=SEND_DESC) if x.clickable), None), 6)
        if not node:
            raise AssertionError("no live Send node (description starting with 'Send') on the screen")
        self.note(f"tapping the live Send node {node.desc[:50]!r} at {node.center} (cached online point was {self.h.get('send')})")
        self.d.tap(node)

    def wait_arrival(self, tag, before, seconds):
        end = time.time() + seconds
        t0 = time.time()
        while time.time() < end:
            line = next((l for l in self.fake_lines()[before:] if prompt_text(l) == tag), None)
            if line:
                return round(time.time() - t0, 1), len(re.findall(r'Attached image \\"[^"]+?\\" is saved at:', line))
            time.sleep(0.5)
        return None, 0

    def probe_offline_draft(self):
        """Cases C (online baseline) and B (airplane mode, real Send on the live node, network back). Not a verification flow."""
        out = []

        def log(m):
            out.append(m)
            self.note("probe: " + m)

        def compose(tag):
            self.attach_three()
            self.d.tap_xy(*self.h["field"])
            time.sleep(0.3)
            self.d.type(tag)
            self.d.key(111)
            time.sleep(0.4)

        self.open_bot("Developer")
        # C: online baseline, text plus 3 photos
        compose("BASE3")
        log(self.draft_state("C-composed", "BASE3"))
        before = len(self.fake_lines())
        self.tap_live_send()
        secs, files = self.wait_arrival("BASE3", before, 90)
        log(f"C online baseline: the bot got BASE3 with {files} photos after {secs} s (None = never in 90 s)")
        self.reset(); self.open_bot("Developer")
        # B: airplane mode on the phone, then send, then network back
        compose("AIRPL3")
        self.d.sh("cmd connectivity airplane-mode enable")
        s, off = self.d.wait(lambda s: self.offline_banner(s), 60)
        log(self.draft_state("B-offline-before-send", "AIRPL3"))
        before = len(self.fake_lines())
        self.tap_live_send()
        time.sleep(3)
        log(self.draft_state("B-offline-after-send", "AIRPL3"))
        secs, files = self.wait_arrival("AIRPL3", before, 10)
        log(f"B while offline: the bot got AIRPL3 after {secs} s ({files} photos); None = nothing arrived, as expected")
        self.d.sh("cmd connectivity airplane-mode disable")
        secs, files = self.wait_arrival("AIRPL3", before, 120)
        log(f"B after the network came back: the bot got AIRPL3 with {files} photos after {secs} s (None = never in 120 s)")
        time.sleep(2)
        log(self.draft_state("B-back-online", "AIRPL3"))
        self.reset(); self.open_bot("Developer")
        # Case A (stop the tunnel right after Send) is not run: it kills the tunnel the rest of the run needs, and the offline copy is covered by B.
        with open(f"{self.ev}/probe-offline-draft.txt", "w") as f:
            f.write("\n".join(out) + "\n")

    def f4_seed(self):
        self.open_bot("Planner")
        self.say("Planner", f"LATEQ{LATEQ_SECONDS}")
        self.leave_chat()
        self.open_bot("Researcher")
        self.say("Researcher", "CHOICES")
        self.d.wait(lambda s: s.first(text=r".*Ready to ship the release\?.*"), 15)
        self.leave_chat()

    def wait_paths(self, mark, job_seconds):
        end = time.time() + job_seconds + 25
        while time.time() < end:
            if self.paths_since(mark):
                time.sleep(2.0)
                return self.paths_since(mark)
            time.sleep(0.4)
        return []

    def f5(self):
        self.open_bot("Developer")
        m = self.mark()
        self.say("Developer", f"SLOW{SLOW_SECONDS}")
        self.leave_chat()
        self.tab("Tasks")
        s, running = self.d.wait(lambda s: s.first(text=r"Working · .*"), 5)
        self.shot("f5-tasks-working")
        paths = self.wait_paths(m, SLOW_SECONDS)
        open(f"{self.ev}/f5-paths.txt", "w").write("\n".join(paths))
        s, idle = self.d.wait(lambda s: s.first(text="No bot is working right now."), 10)
        self.shot("f5-tasks-at-reply")
        if not running:
            return "FAIL", "the Tasks tab showed no 'Working · …' card while Developer ran SLOW6"
        if not idle:
            return "FAIL", "after the reply the Tasks tab never showed 'No bot is working right now.'"
        if paths and set(paths) == {"in-app"}:
            return "PASS", "Tasks tab showed Developer 'Working · …', then 'No bot is working right now.'; server logged path in-app and nothing else"
        return "FAIL", f"server paths on the Tasks tab: {','.join(paths) or 'none'} (want in-app only)"

    def f4(self):
        self.tab("Tasks")
        s, card = self.d.wait(lambda s: s.first(text=r"Which build should go out tonight\?"), 3)
        if not card:
            work = next((n for n in s.find(desc=r"Work, \d+") if n.clickable), None)
            if work:
                self.d.tap(work)
                time.sleep(0.6)
            s, card = self.d.wait(lambda s: s.first(text=r"Which build should go out tonight\?"), 8)
        self.shot("f4-work")
        texts = s.texts()
        open(f"{self.ev}/f4-work-texts.txt", "w").write("\n".join(texts))
        questions = [n for n in s.nodes if n.rid.startswith("work-question-") and s.drawn(n)]
        opens = [n for n in s.nodes if n.rid.startswith("work-open-chat-") and s.drawn(n)]
        read_q = [t for t in texts if "Ready to ship the release?" in t]
        reports = [t for t in texts if re.search(r"Slow job finished|Summary line for the long report|Got it\.|End of the long report", t)]
        self.work_open = opens[0] if opens else None
        if not card:
            return "FAIL", "no Work card shows Planner's unread question as visible text"
        if read_q:
            return "FAIL", "a Work card shows the question from the chat that was already read"
        if reports:
            return "FAIL", f"a Work card shows a report with no question: {reports[0][:50]!r}"
        if len(questions) != 1 or len(opens) != 1:
            return "FAIL", f"{len(questions)} question cards and {len(opens)} Open-chat buttons visible (want 1 and 1)"
        if not s.first(text=r"Planner · .*"):
            return "FAIL", "the card does not name Planner as the asker"
        return "PASS", "1 card with Planner's unread question, none for the read Researcher question, none for Developer reports"

    def f6(self):
        self.open_bot("Researcher")
        m = self.mark()
        self.say("Researcher", f"SLOW{SLOW_BACKGROUND_SECONDS}")
        self.leave_chat()
        self.d.key(3)
        paths = self.wait_paths(m, SLOW_BACKGROUND_SECONDS)
        open(f"{self.ev}/f6-paths.txt", "w").write("\n".join(paths))
        self.d.sh(f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1")
        time.sleep(1.5)
        self.to_chats()
        s, row = self.d.wait(lambda s: self.bot_row(s, "Researcher"), 8)
        preview = None
        if row:
            l, t, r, b = row.box
            preview = next((n for n in s.nodes if n.text == "Slow job finished." and s.drawn(n) and l <= n.center[0] <= r and t <= n.center[1] <= b), None)
        self.shot("f6-back-in-app")
        if not (paths and set(paths) == {"push"}):
            return "FAIL", f"server paths in the background: {','.join(paths) or 'none'} (want push only)"
        if not preview:
            return "FAIL", "back in the app the Researcher row does not show the reply 'Slow job finished.' as its preview"
        return "PASS", "server logged path push only with the app in the background; back in the app the Researcher row shows 'Slow job finished.'"

    def f8(self):
        bad = []
        self.to_chats()
        s, row = self.d.wait(lambda s: self.bot_row(s, "Researcher"), 6)
        if row:
            self.d.tap(row)
            time.sleep(1.0)
            s, c = self.d.wait(lambda s: s.first(desc=r"Message Researcher…") and s.first(text=r"Idle .*"), 8)
            if not c:
                bad.append("chats-open")
            elif not s.first(text=r".*Ready to ship the release\?.*"):
                bad.append("chats-open-wrong-chat")
            self.d.key(4)
            time.sleep(1.0)
            s = self.d.dump()
            if not (self.tabs_visible(s) and self.tabs_text_visible(s) and s.first(text="Search bots and chats")):
                bad.append("chats-back")
        else:
            bad.append("chats-no-row")
        self.tab("Tasks")
        s, card = self.d.wait(lambda s: next((n for n in s.nodes if n.rid.startswith("work-open-chat-") and s.drawn(n)), None), 6)
        if card:
            self.d.tap(card)
            time.sleep(1.0)
            s, c = self.d.wait(lambda s: s.first(desc=r"Message Planner…") and s.first(text=r"Idle .*"), 8)
            if not c:
                bad.append("tasks-open")
            elif not s.first(text=r".*Which build should go out tonight\?.*"):
                bad.append("tasks-open-wrong-chat")
            self.d.key(4)
            time.sleep(1.0)
            s = self.d.dump()
            if not (self.tabs_visible(s) and self.tabs_text_visible(s) and s.first(text="Running now")):
                bad.append("tasks-back")
        else:
            bad.append("tasks-no-card")
        self.tab("Computer")
        s, c = self.d.wait(lambda s: s.first(text="THIS LAPTOP"), 6)
        self.shot("f8-computer")
        if not c or not s.first(text="Computer"):
            bad.append("computer-tab")
        self.tab("Files")
        s, f = self.d.wait(lambda s: s.first(text="Files") and (s.first(text="No files yet") or s.first(text=r".*\.png")), 6)
        self.shot("f8-files")
        if not f:
            bad.append("files-tab")
        self.tab("Chats")
        pid = self.d.sh(f"pidof {PKG}").strip()
        log = self.d.run("logcat", "-d", timeout=60)
        open(f"{self.ev}/logcat.txt", "w").write(log)
        # Only a crash of the app counts. The UiAutomation dump tool can die on its own ("FATAL EXCEPTION: UiAutomation", seen once), which is not the app.
        fatal = len(re.findall(rf"FATAL EXCEPTION[^\n]*\n[^\n]*Process: {re.escape(PKG)}", log))
        tool_fatal = log.count("FATAL EXCEPTION") - fatal
        if tool_fatal:
            self.note(f"logcat has {tool_fatal} FATAL EXCEPTION line(s) that are not the app (uiautomator dump tool), not counted")
        js = len(re.findall(r"JavascriptException|E ReactNativeJS|ReactNativeJS: .*(TypeError|ReferenceError|Unhandled|Invariant Violation)", log))
        self.shot("f8-end")
        if bad or not pid or fatal or js:
            return "FAIL", f"steps failed: {','.join(bad) or 'none'}; pid={pid or 'none'} FATAL={fatal} JS-errors={js}"
        return "PASS", f"Researcher chat (its question visible) and Planner chat (its question visible) opened from Chats and from a Work card and closed with the system Back key, Computer and Files visited, app pid {pid} alive, FATAL 0, JS errors 0"

    def approval_card(self, s, bot="Developer"):
        return s.first(text=rf"{bot} needs approval") and s.first(text="Run a command") and s.first(desc="Approve")

    def ask_approval(self, tag, bot="Developer"):
        """Send SAFETYQ: the fake CLI asks for a Bash approval like Claude Code's safety check does. Waits for the card."""
        self.say(bot, "SAFETYQ")
        s, ok = self.d.wait(lambda s: self.approval_card(s, bot), 30)
        self.shot(f"f10-{tag}-card")
        if not ok:
            raise AssertionError(f"{tag}: no approval card (title, 'Run a command', Approve) appeared")
        if not s.first(text=r".*\$AD snapshot -i.*"):
            raise AssertionError(f"{tag}: the card does not show the command")
        if not s.first(text=r"Claude Code can't be sure it read this command.*"):
            raise AssertionError(f"{tag}: the card does not show the CLI's reason")
        return s

    def f10(self):
        """Tool approvals (1.67.50): the card, the Chats row, Approve, Deny and the server's 2-minute auto-decline."""
        self.open_bot("Developer")
        self.ask_approval("approve")
        # The Chats row says Needs approval, and tapping it opens the chat at the card.
        self.leave_chat()
        self.to_chats()
        s, row = self.d.wait(lambda s: next((n for n in s.find(desc=r"Developer, .*Needs approval.*") if n.clickable), None), 20)
        self.shot("f10-chats-needs-approval")
        if not row:
            return "FAIL", "the Developer row never read Needs approval"
        self.d.tap(row)
        s, ok = self.d.wait(self.approval_card, 15)
        self.shot("f10-opened-from-row")
        if not ok:
            return "FAIL", "tapping the Needs approval row did not open the chat at the card"
        s.first(desc="Approve") and self.d.tap(s.first(desc="Approve"))
        s, ok = self.d.wait(lambda s: s.first(text=r"Approved: the command ran\.") and not s.first(desc="Approve"), 20)
        self.shot("f10-approved")
        if not ok:
            return "FAIL", "after Approve the bot did not say 'Approved: the command ran.' or the card stayed"
        self.learn(self.d.dump())
        s = self.ask_approval("deny")
        self.d.tap(s.first(desc="Deny"))
        s, ok = self.d.wait(lambda s: s.first(text=r"Denied: User declined tool execution\.") and not s.first(desc="Approve"), 20)
        self.shot("f10-denied")
        if not ok:
            return "FAIL", "after Deny the bot did not get 'User declined tool execution.' or the card stayed"
        self.learn(self.d.dump())
        legs = "card with command and reason; Chats row Needs approval opened the chat at the card; Approve ran it; Deny declined it"
        if self.f10_timeout:
            verdict, reason = self.f10_timeout
            return verdict, (f"{legs}; {reason}" if verdict == "PASS" else f"timeout leg ({F10_TIMEOUT_BOT}): {reason}")
        self.ask_approval("timeout")
        self.f10_since = time.time()
        verdict, reason = self.f10_tail("Developer")
        return verdict, (f"{legs}; {reason}" if verdict == "PASS" else reason)

    def f10_start(self):
        """Flow 10's timeout leg, first: ask for an approval in the F10_TIMEOUT_BOT chat and leave it unanswered."""
        self.open_bot(F10_TIMEOUT_BOT)
        self.ask_approval("timeout", F10_TIMEOUT_BOT)
        self.f10_since = time.time()
        self.leave_chat()

    def f10_tail(self, bot):
        """The end of flow 10's timeout leg: the server declines the unanswered card after 2 minutes, and the Chats row clears."""
        if self.f10_early:
            self.open_bot(bot)
            if time.time() - self.f10_since < 112:
                s, ok = self.d.wait(lambda s: self.approval_card(s, bot), 10)
                self.shot("f10-reopened-pending")
                if not ok:
                    return "FAIL", f"reopened {round(time.time() - self.f10_since)}s after the card was sent, the card was no longer waiting with Approve"
        s, ok = self.d.wait(lambda s: s.first(text=r"Denied: No one answered this approval within 2 minutes\..*") and not s.first(desc="Approve"), max(10, 200 - (time.time() - self.f10_since)), every=3)
        waited = round(time.time() - self.f10_since)
        self.shot("f10-timed-out")
        if not ok:
            return "FAIL", f"no auto-decline after {waited}s"
        took = decline_seconds(self.fake_lines())
        if took is None:
            return "FAIL", "the fake CLI log does not show when the approval was asked and declined, so the 2 minutes cannot be checked"
        if took < F10_MIN_DECLINE:
            return "FAIL", f"the server declined the card {took:.0f}s after it was asked, before the 2 minutes it promises (seen on screen at {waited}s)"
        self.leave_chat()
        self.to_chats()
        s, row = self.d.wait(lambda s: next((n for n in s.find(desc=rf"{bot}, .*") if n.clickable), None), 10)
        self.shot("f10-chats-after")
        if row and "Needs approval" in row.desc:
            return "FAIL", f"the {bot} Chats row still reads Needs approval after the request resolved"
        during = f" ({bot} chat; flows {','.join(map(str, self.f10_filled))} ran during the wait)" if self.f10_early else ""
        return "PASS", f"unanswered card auto-declined {took:.0f}s after it was asked (seen on screen at ~{waited}s) with the retry advice; row cleared{during}"

    def restart_row(self):
        for _ in range(8):
            s = self.d.dump()
            row = next((n for n in s.find(rid="settings-restart-laptop") if s.drawn(n)), None) or next((n for n in s.find(desc=r"Restart laptop.*") if n.clickable), None)
            if row:
                return s, row
            self.d.swipe(540, 1700, 540, 700, 350)
            time.sleep(0.6)
        return s, None

    def f11(self):
        """Restart laptop (1.67.50): Settings row, 2 s hold, confirm sheet, restarting state. Server runs with HBOTS_REBOOT_DRY_RUN=1."""
        self.to_chats()
        s = self.d.dump()
        gear = next((n for n in s.find(desc="Settings") if n.clickable), None)
        if not gear:
            return "FAIL", "no Settings button on Chats"
        self.d.tap(gear)
        time.sleep(1.2)
        s, row = self.restart_row()
        self.shot("f11-settings-row")
        if not row:
            return "FAIL", "Settings has no Restart laptop row for the owner phone"
        self.d.tap(row)
        s, ok = self.d.wait(lambda s: s.first(text=r"Hold the row for 2 seconds to restart\."), 5)
        self.shot("f11-short-tap-hint")
        if not ok:
            return "FAIL", "a short tap did not show the hold hint"
        x, y = row.center
        self.d.swipe(x, y, x, y, 2600)
        s, ok = self.d.wait(lambda s: s.first(text=r"Restart the laptop\?") and s.first(rid="restart-laptop-confirm-button"), 8)
        self.shot("f11-confirm-sheet")
        if not ok:
            return "FAIL", "holding the row 2.6 s did not open the confirm sheet"
        self.d.tap(s.first(rid="restart-laptop-confirm-button"))
        s, ok = self.d.wait(lambda s: s.first(text=r"Restarting\. The app reconnects when the laptop is back \(about 1-2 min\)\."), 15)
        self.shot("f11-restarting")
        if not ok:
            err = s.first(rid="restart-laptop-error")
            return "FAIL", f"no restarting text after Restart; error: {err.text if err else 'none'}"
        dry = bool(s.first(text=r"Dry run: .*"))
        # The server accepts at once and logs "would reboot" when its dry run fires, 1000 ms later.
        t = time.time()
        while not (logged := any("would reboot" in line for line in open(self.srvlog, errors='replace').read().splitlines())) and time.time() - t < 8:
            time.sleep(0.5)
        if not logged:
            return "FAIL", "the throwaway server log has no 'would reboot' line within 8 s of the restarting text"
        return "PASS", f"row shown to the owner; short tap gives the hold hint; 2.6 s hold opened the confirm sheet; Restart showed the restarting text (dry-run note {'shown' if dry else 'not shown'}); server logged 'would reboot'"

    def secret_card(self, s):
        return next((n for n in s.find(desc=r"Developer needs a secret")), None)

    def secret_fields(self, s):
        """(value field, address field, Save button) of the pending card, each None when not drawn. The value field sits right under
        the key name, the address field right under the 'Allowed address' label; the composer is left out."""
        card, name, label = self.secret_card(s), s.first(text="QA_FLOW12_KEY"), s.first(text="Allowed address")
        edits = [n for n in s.find() if n.cls.endswith("EditText") and card and n.box[1] >= card.box[1] and n.box[3] <= card.box[3]]
        value = next((n for n in edits if name and n.box[1] >= name.box[3] and (not label or n.box[3] <= label.box[1])), None)
        address = next((n for n in edits if label and n.box[1] >= label.box[3]), None)
        save = next((n for n in s.find(desc="Save secret") if n.clickable), None) or s.first(text="Save secret")
        return value, address, save

    def card_to_top(self, s):
        """The card scrolls inside a fixed height: swipe down within it until the value field is drawn."""
        for _ in range(4):
            value, _, _ = self.secret_fields(s)
            if value:
                return s
            card = self.secret_card(s)
            if not card:
                return s
            x = (card.box[0] + card.box[2]) // 2
            self.d.swipe(x, card.box[1] + 120, x, card.box[3] - 200, 400)
            time.sleep(0.8)
            s = self.d.dump()
        return s

    def card_to_bottom(self, s):
        """Swipe up within the chat until the card's address field and Save button are both drawn."""
        for _ in range(4):
            _, address, save = self.secret_fields(s)
            if address and save:
                return s
            self.d.swipe(540, 1500, 540, 900, 400)
            time.sleep(0.8)
            s = self.d.dump()
        return s

    def f12(self):
        """Secret request card (1.67.53): Save with no address shows the problem above the buttons, drawn on screen; typing the address clears it and Save stores the key.
        The pending card sets FLAG_SECURE, so the screenshots are black: the checks read the UI dump."""
        self.open_bot("Developer")
        self.say("Developer", 'MCPONCE request_secret {"name":"QA_FLOW12_KEY","label":"QA flow 12 key","purpose":"verify flow 12"}')
        s, ok = self.d.wait(lambda s: self.secret_card(s), 30)
        if not ok:
            return "FAIL", "no secret card (Developer needs a secret) appeared"
        s = self.card_to_top(s)
        value, _, _ = self.secret_fields(s)
        if not value:
            return "FAIL", "the card's value field never came into view"
        self.d.tap(value)
        time.sleep(0.4)
        self.d.type("qa-flow12-value")
        self.d.key(111)
        time.sleep(0.8)
        s = self.card_to_bottom(self.d.dump())
        _, address, save = self.secret_fields(s)
        if address and address.text not in ("", "https://api.vercel.com"):
            return "FAIL", f"the value went into the address field ({address.text!r})"
        if not save:
            return "FAIL", "Save secret is not on screen after typing the value"
        self.d.tap(save)
        problem = r"Enter the address this key may be sent to.*"
        s, ok = self.d.wait(lambda s: s.first(text=problem), 8)
        open(f"{self.ev}/f12-problem-dump.txt", "w").write("\n".join(repr(n) for n in s.nodes if n.text or n.desc))
        if not ok:
            return "FAIL", "Save with no address showed no problem text on screen (the 1.67.52 card could leave it out of view)"
        p = s.first(text=problem)
        _, address, save = self.secret_fields(s)
        if save and not (p.box[3] <= save.box[1] + 4 and save.box[1] - p.box[3] < 400):
            return "FAIL", f"the problem text is not just above the buttons (text {p.box}, Save {save.box})"
        if not address:
            return "FAIL", "the address field is not on screen next to the problem"
        self.d.tap(address)
        time.sleep(0.4)
        self.d.type("https://api.example.com")
        self.d.key(111)
        s, ok = self.d.wait(lambda s: not s.first(text=problem) and self.secret_fields(s)[2], 8)
        if not ok:
            return "FAIL", "typing a valid address did not clear the problem text"
        self.d.tap(self.secret_fields(s)[2])
        saved = r"You saved QA flow 12 key\..*"
        # The task resumes once the key is saved and its reply can push the settled card up the chat,
        # so look for a few seconds, then scroll back up a little and look again (24 s at most).
        t = time.time()
        s, ok = self.d.wait(lambda s: s.first(text=saved), 5)
        while not ok and time.time() - t < 24:
            self.d.swipe(540, 700, 540, 1500, 300)
            time.sleep(0.6)
            s, ok = self.d.wait(lambda s: s.first(text=saved), 3)
        self.shot("f12-saved")
        if not ok:
            shown = [x for x in s.texts() if "secret" in x.lower() or "try again" in x.lower() or "address" in x.lower()][:4]
            return "FAIL", f"the card did not settle as saved; on screen: {shown}"
        return "PASS", f"Save with no address showed the address problem on screen just above the buttons (text {p.box}); a valid address cleared it; Save settled the card as saved"

    def f13_find(self, s, pat):
        """A drawn node whose text or content-desc matches pat (a Row may merge its texts into content-desc)."""
        return s.first(text=pat) or s.first(desc=pat)

    def f13_scroll_to(self, pat, tries=8, up_first=False):
        if up_first:
            for _ in range(3):
                self.d.swipe(540, 700, 540, 1800, 300)
                time.sleep(0.4)
        for _ in range(tries):
            s = self.d.dump()
            n = self.f13_find(s, pat)
            if n:
                return s, n
            self.d.swipe(540, 1700, 540, 900, 350)
            time.sleep(0.6)
        return s, None

    def f13(self):
        """Email (1.67.54): Settings > Integrations > Email on a laptop with no Thunderbird bridge (the QA server's throwaway HOME has
        none), so the page must show the repair state, never a Found row, Use these accounts or a raw error; Back returns to Integrations."""
        night = self.d.sh("cmd uimode night").strip() if hasattr(self.d, "sh") else "?"
        size = self.d.sh("wm size").strip() + "; " + self.d.sh("wm density").strip()
        self.to_chats()
        s = self.d.dump()
        gear = next((n for n in s.find(desc="Settings") if n.clickable), None)
        if not gear:
            return "FAIL", "no Settings button on Chats"
        self.d.tap(gear)
        time.sleep(1.2)
        s, row = self.f13_scroll_to(r"(?s)Integrations.*", up_first=True)
        self.shot("f13-settings-integrations-row")
        if not row:
            return "FAIL", "Settings has no Integrations row"
        hint = bool(self.f13_find(s, r"(?s).*Email, GitHub, WhatsApp and other accounts bots can use.*"))
        self.d.tap(row)
        s, ok = self.d.wait(lambda s: self.f13_find(s, r"(?s)Email.*") and self.f13_find(s, r"(?s).*Gmail and Outlook, read through Thunderbird on the laptop.*"), 10)
        self.shot("f13-integrations")
        if not ok:
            return "FAIL", f"Integrations did not show the Email row; on screen: {s.texts()[:8]}"
        title = bool(self.f13_find(s, r"Integrations"))
        self.d.tap(self.f13_find(s, r"(?s).*Gmail and Outlook, read through Thunderbird on the laptop.*") or self.f13_find(s, r"(?s)Email.*"))
        t0 = time.time()
        s, ok = self.d.wait(lambda s: self.f13_find(s, r"(?s).*Ask a bot to repair email\..*"), 25)
        settle = time.time() - t0
        self.shot("f13-email-no-thunderbird")
        if not ok:
            return "FAIL", f"the Email page did not settle on the repair state in 25 s; on screen: {s.texts()[:10]}"
        line = bool(self.f13_find(s, r"(?s).*The Commonpost mail bridge is not installed on the laptop\..*"))
        state = bool(self.f13_find(s, r"(?s).*Needs attention.*"))
        tb_row = bool(self.f13_find(s, r"(?s).*Thunderbird on the laptop.*"))
        bad = [p for p in (r"(?s).*Use these accounts.*", r"(?s)Found.*", r"(?s).*Connected.*", r"(?s).*Not reachable.*") if self.f13_find(s, p)]
        if not (line and tb_row) or bad:
            return "FAIL", f"repair state wrong: bridge line {line}, Thunderbird row {tb_row}, Needs attention {state}, unexpected {bad}; on screen: {s.texts()[:10]}"
        for _ in range(3):
            time.sleep(2)
            s2 = self.d.dump()
            if self.f13_find(s2, r"(?s)Found.*") or not self.f13_find(s2, r"(?s).*Ask a bot to repair email\..*"):
                self.shot("f13-email-flapped")
                return "FAIL", "the repair state did not hold for 6 s"
        self.d.key(4)
        s, ok = self.d.wait(lambda s: self.f13_find(s, r"(?s).*Gmail and Outlook, read through Thunderbird on the laptop.*"), 6)
        self.shot("f13-back-integrations")
        if not ok:
            return "FAIL", "Back from Email did not return to Integrations"
        self.d.key(4)
        time.sleep(1)
        return "PASS", (f"Settings row Integrations (hint {'shown' if hint else 'NOT shown'}), Integrations title {'shown' if title else 'not found'} with the Email row; "
                        f"Email settled in {settle:.1f} s on the repair state: Thunderbird on the laptop {'Needs attention' if state else '(state text not found)'}, "
                        f"'The Commonpost mail bridge is not installed on the laptop.', 'Ask a bot to repair email.'; no Found, Connected or Use these accounts; held 6 s; Back returned to Integrations; device {night}; {size}")

    def f14_open_lead(self, bot):
        """Open a team lead's chat. A lead sits in the pinned strip as a tile ("Assistant", or "Assistant, <status>"), not a list row."""
        row = self.bot_row
        self.bot_row = lambda s, b: row(s, b) or next((n for n in s.find(desc=rf"{b}(, .*)?") if n.clickable), None)
        try:
            return self.open_bot(bot)
        finally:
            del self.bot_row

    def f14(self):
        """Working in background (1.67.55): Assistant delegates a task to Planner whose turn starts a background command (fake BGSTART) and
        ends with it still running, so the task stays running with waitingOnBackgroundSince. The task card in Assistant's chat, Planner's
        row on the Bots list and the header of Planner's task chat must all say "Working in background" (the row never "Ready", the
        header never "Idle"). Interrupting the task from the card clears the row's label."""
        label = r"(?s).*Working in background.*"
        night = self.d.sh("cmd uimode night").strip()
        size = self.d.sh("wm size").strip() + "; " + self.d.sh("wm density").strip()
        self.f14_open_lead("Assistant")
        self.say("Assistant", 'MCPONCE delegate_task {"targetBot":"Planner","title":"QA background build","objective":"BGSTART"}')
        # The card: the child's turn ends with the command live, then the server marks the task (taskSettling publishWaitingPreview).
        find = lambda s, pat: s.first(text=pat) or s.first(desc=pat)
        s, card = self.d.wait(lambda s: find(s, label) and find(s, r"(?s).*Planner.*"), 45)
        self.shot("f14-card-working-in-background")
        if not card:
            shown = [t for t in s.texts() if re.search(r"Working|Queued|Done|Planner", t)]
            return "FAIL", f"the task card never said 'Working in background' in 45 s; on screen: {shown[:8]}"
        # The header of the task's own chat, opened from the card.
        opener = next((n for n in s.find(desc=r"Open Planner's chat for this task") if n.clickable), None)
        if not opener:
            return "FAIL", "the task card has no way into Planner's chat"
        self.d.tap(opener)
        s, head = self.d.wait(lambda s: find(s, label) and s.first(desc=r"Message Planner.*"), 12)
        self.shot("f14-header-working-in-background")
        if not head:
            return "FAIL", f"Planner's task chat header did not say 'Working in background'; on screen: {s.texts()[:10]}"
        idle = bool(s.first(text=r"Idle") or s.first(desc=r"Idle(, .*)?"))
        self.leave_chat()
        self.leave_chat()
        # The row on the Bots list: status in the drawn row, never Ready, sorted with the working bots (above the idle seeded bots).
        self.to_chats()
        s, row = self.d.wait(lambda s: next((n for n in s.find(desc=r"Planner, .*Working in background.*") if n.clickable), None), 12)
        self.shot("f14-row-working-in-background")
        if not row:
            pl = next((n.desc for n in s.find(desc=r"Planner, .*") if n.clickable), "no Planner row")
            return "FAIL", f"Planner's row did not say 'Working in background': {pl[:120]!r}"
        # The status as drawn text inside the row, when the row exposes its texts (the screenshot shows it either way).
        status_drawn = any(s.drawn(n) and re.fullmatch(label, n.text or "") and row.box[1] <= n.box[1] <= row.box[3] for n in s.nodes)
        ready = bool(re.search(r", Ready,", row.desc))
        rows = [n for n in s.nodes if n.clickable and re.match(r"(Assistant|Researcher|Developer|Planner), ", n.desc or "") and s.drawn(n)]
        order = [r.desc.split(",")[0] for r in sorted(rows, key=lambda n: n.box[1])]
        idle_rows = [order.index(b) for b in ("Researcher", "Developer") if b in order]
        above_idle = "Planner" in order and bool(idle_rows) and order.index("Planner") < max(idle_rows)
        if idle or ready:
            return "FAIL", f"row and header disagree: header Idle {idle}, row Ready {ready}"
        # Clearing: interrupt the task from the card, then the row must stop saying it.
        self.f14_open_lead("Assistant")
        s, stop = self.d.wait(lambda s: next((n for n in s.find(text=r"Interrupt") if s.drawn(n)), None), 8)
        if not stop:
            return "FAIL", "the running task card has no Interrupt button"
        self.d.tap(stop)
        s, gone = self.d.wait(lambda s: not find(s, label), 20)
        self.shot("f14-card-after-interrupt")
        self.leave_chat()
        self.to_chats()
        s, cleared = self.d.wait(lambda s: next((n for n in s.find(desc=r"Planner, .*") if n.clickable and "Working in background" not in n.desc), None), 20)
        self.shot("f14-row-after-interrupt")
        if not (gone and cleared):
            return "FAIL", f"after Interrupt: card cleared {bool(gone)}, row cleared {bool(cleared)}"
        return "PASS", (f"card, header and row all said 'Working in background' (header not Idle, row not Ready, row status as its own text node: {status_drawn}); "
                        f"Bots order {order} (Planner above an idle bot: {above_idle}); Interrupt cleared card and row "
                        f"(row now {cleared.desc.split(', ')[2] if cleared.desc.count(', ') >= 2 else cleared.desc[:40]!r}); device {night}; {size}")

    def flows(self):
        order = [(1, "chat-send-reply", self.f1), (7, "swipe-quote", self.f7), (9, "long-press-reply", self.f9), (3, "camera-entry-once", self.f3), (2, "pick-three-photos", self.f2),
                 ("4s", None, self.f4_seed), (5, "in-app-on-tasks-tab", self.f5), (4, "work-card-unread-only", self.f4), (6, "background-goes-push", self.f6), (8, "open-and-back-logcat-clean", self.f8), (10, "tool-approval-card", self.f10), (11, "restart-laptop-dry-run", self.f11), (12, "secret-card-problem", self.f12),
                 (13, "email-integrations", self.f13), (14, "working-in-background", self.f14)]
        only = set(self.a.only.split(",")) if self.a.only else None
        seed_secs = 0
        self.order = order
        ran = []
        # Flow 10's timeout leg waits for the server's real 2-minute auto-decline. With fillers to run,
        # it starts first ("10t") and the fillers run during the wait; f10 later checks the other legs.
        fillers = [f for f in F10_FILLERS if not only or str(f) in only]
        self.f10_early = os.environ.get("VERIFY_F10_OVERLAP", "1") != "0" and bool(fillers) and (not only or "10" in only)
        self.f10_pending = False
        self.f10_timeout = None
        self.f10_filled = []
        if self.f10_early:
            order = self.order = overlap_order(order, (("10t", "tool-approval-timeout-start", self.f10_start)))
        for flow, name, fn in order:
            # The seed ("4s") serves flow 4 and flow 8 (the two questions flow 8 opens).
            if only and (flow == "4s" and not only & {"4", "8"} or flow not in ("4s", "10t") and str(flow) not in only):
                continue
            if self.f10_pending and (flow not in F10_FILLERS or time.time() - self.f10_since + F10_TYPICAL[flow] > F10_DECLINE_AT):
                # The fillers are done, or this one would end after the decline: finish the timeout leg first.
                if not self.finish_f10(ran):
                    return
            if self.f10_pending:
                self.f10_filled.append(flow)
            ran.append(flow)
            s0 = self.snap()
            try:
                self.reset()
            except Exception as e:
                self.note(f"reset before flow {flow} failed: {type(e).__name__}: {str(e)[:120]}")
            s1 = self.snap()
            prob = self.link_problem()
            if prob:
                self.link_lost(flow, name, prob, ran)
                return
            s2 = self.snap()
            self.timing[str(flow)] = {"reset": split(s0, s1), "link": split(s1, s2)}
            t = time.time()
            if flow == "4s":
                try:
                    fn()
                except Exception as e:
                    self.note(f"seed for flow 4 failed: {type(e).__name__}: {e}")
                seed_secs = time.time() - t
                self.timing[str(flow)]["flow"] = split(s2, self.snap())
                self.note(f"timing seed: reset {split_text(self.timing[str(flow)]['reset'])}; flow {split_text(self.timing[str(flow)]['flow'])}")
                continue
            if flow == "10t":
                try:
                    fn()
                    self.f10_pending = True
                    self.note(f"flow 10 timeout leg: an unanswered approval is waiting in the {F10_TIMEOUT_BOT} chat for the server's 2-minute auto-decline")
                except Exception as e:
                    self.f10_timeout = ("FAIL", f"{type(e).__name__}: {str(e)[:160]}")
                    self.save_diag("f10-timeout-start-fail")
                self.f10_secs = time.time() - t
                self.timing[str(flow)]["flow"] = split(s2, self.snap())
                self.note(f"timing f10 timeout start: reset {split_text(self.timing[str(flow)]['reset'])}; flow {split_text(self.timing[str(flow)]['flow'])}")
                continue
            try:
                verdict, reason = fn()
            except Exception as e:
                verdict, reason = "FAIL", f"{type(e).__name__}: {str(e)[:160]}"
            secs = time.time() - t + (seed_secs if flow == 4 else 0) + (getattr(self, "f10_secs", 0) if flow == 10 else 0)
            tm = self.timing[str(flow)]
            tm["flow"] = split(s2, self.snap())
            self.note(f"timing f{flow}: reset {split_text(tm['reset'])}; link check {tm['link']['wall']:.1f} s; flow {split_text(tm['flow'])}")
            if verdict == "FAIL":
                try:
                    self.shot(f"f{flow}-fail")
                    self.save_diag(f"f{flow}-fail")
                except Exception:
                    pass
                prob = self.link_problem(full=True)
                if prob:
                    self.result(flow, name, "LINK-LOST", f"{reason} (not an app verdict: {prob})", secs)
                    self.link_lost(flow, name, prob, ran)
                    return
            self.result(flow, name, verdict, reason, secs)
        if self.f10_pending:
            self.finish_f10(ran)

    def finish_f10(self, ran):
        """Finish flow 10's timeout leg after the fillers; f10 reports it with the other legs. False when the link was lost."""
        flow, name = 10, "tool-approval-card"
        self.f10_pending = False
        s0 = self.snap()
        try:
            self.reset()
        except Exception as e:
            self.note(f"reset before flow {flow}'s tail failed: {type(e).__name__}: {str(e)[:120]}")
        s1 = self.snap()
        prob = self.link_problem()
        if prob:
            self.link_lost(flow, name, prob, ran)
            return False
        s2 = self.snap()
        t = time.time()
        try:
            verdict, reason = self.f10_tail(F10_TIMEOUT_BOT)
        except Exception as e:
            verdict, reason = "FAIL", f"{type(e).__name__}: {str(e)[:160]}"
        self.timing["10t"]["tail"] = {"reset": split(s0, s1), "link": split(s1, s2), "flow": split(s2, self.snap())}
        tm = self.timing["10t"]["tail"]
        self.note(f"timing f10 timeout tail: reset {split_text(tm['reset'])}; link check {tm['link']['wall']:.1f} s; flow {split_text(tm['flow'])}")
        self.f10_secs = getattr(self, "f10_secs", 0) + time.time() - t
        if verdict == "FAIL":
            try:
                self.shot("f10-timeout-fail")
                self.save_diag("f10-timeout-fail")
            except Exception:
                pass
            prob = self.link_problem(full=True)
            if prob:
                self.result(flow, name, "LINK-LOST", f"{reason} (not an app verdict: {prob})", self.f10_secs)
                self.link_lost(flow, name, prob, ran)
                return False
        self.note(f"flow 10 timeout leg {verdict}: {reason}")
        self.f10_timeout = (verdict, reason)
        return True

    def link_lost(self, flow, name, prob, ran):
        """The link to the throwaway server dropped. That is a setup failure (exit 2), never a flow FAIL: flows after this one are not judged."""
        only = set(self.a.only.split(",")) if self.a.only else None
        done = {str(x[0]) for x in self.results}
        left = [str(f) for f, _, _ in self.order if str(f).isdigit() and str(f) not in done and (not only or str(f) in only)]
        self.setup_reason = f"link lost at flow {flow} ({name}), not an app verdict, flows {','.join(left)} not judged, rerun: {prob}"
        self.note(f"LINK LOST: {self.setup_reason}")
        self.shot(f"link-lost-f{flow}")


def overlap_order(order, start):
    """The run order for the overlap: flow 10's timeout start first, then the F10_FILLERS, then the rest in order."""
    fill = [e for e in order if e[0] in F10_FILLERS]
    rest = [e for e in order if e[0] not in F10_FILLERS]
    return [start] + fill + rest


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apk", required=True)
    p.add_argument("--adb", required=True)
    p.add_argument("--evidence", required=True)
    p.add_argument("--srv", required=True)
    p.add_argument("--link-host", required=True)
    p.add_argument("--only", default="")
    p.add_argument("--probe", default="")
    p.add_argument("--tunnel-unit", default="")
    p.add_argument("--tunnel-log", default="")
    a = p.parse_args()
    time.sleep = counted_sleep  # every sleep in drive.py and ui.py is counted for the timing lines
    r = Run(a)
    try:
        return run_all(r, a)
    finally:
        r.d.stop_dumper()


def run_all(r, a):
    try:
        r.setup()
    except Exception as e:
        r.note(f"SETUP FAILED: {type(e).__name__}: {e}")
        open(f"{r.ev}/setup-reason.txt", "w").write(f"{type(e).__name__}: {str(e)[:160]}\n")
        r.save_diag("setup-fail")
        return 2
    if a.probe == "offline-draft":
        t = time.time()
        r.probe_offline_draft()
        json.dump({"version": r.version, "probe": a.probe, "flows_seconds": round(time.time() - t), "setup_reason": "", "results": []}, open(f"{r.ev}/drive.json", "w"), indent=1)
        return 0
    t = time.time()
    r.flows()
    total = time.time() - t
    fails = [x for x in r.results if x[2] != "PASS"]
    json.dump({"version": r.version, "flows_seconds": round(total), "setup_reason": r.setup_reason, "timing": r.timing, "setup_timing": getattr(r, "setup_timing", None), "results": [dict(zip(("flow", "name", "verdict", "reason", "secs"), x)) for x in r.results]}, open(f"{r.ev}/drive.json", "w"), indent=1)
    if r.setup_reason:
        open(f"{r.ev}/setup-reason.txt", "w").write(r.setup_reason + "\n")
        r.note(f"SETUP FAILED (exit 2): {r.setup_reason}")
        return 2
    r.note(f"DONE {len(r.results) - len(fails)} PASS, {len(fails)} FAIL, flows {total:.0f} s")
    return 1 if fails or not r.results else 0


if __name__ == "__main__":
    sys.exit(main())
