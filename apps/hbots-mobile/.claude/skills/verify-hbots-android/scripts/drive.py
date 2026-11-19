#!/usr/bin/env python3
"""verify-hbots-android driver. python3 -I drive.py --apk A --adb "adb -P .. -s .." --evidence DIR --srv DIR --link-host URL [--only 1,2]
Exit 0 all flows PASS, 1 a flow FAILED, 2 setup failed or the link to the throwaway server was lost (no verdict)."""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ui import Device  # noqa: E402

PKG = "com.haroutb5.hbots"
LONG_PARAGRAPH = "The quarterly report shows revenue grew in every region, with the strongest gains in the north where the new warehouse opened in March. "
LONG_REPLY = " ".join(("Summary line for the long report.\n\n" + LONG_PARAGRAPH * 4 + "\n\n" + LONG_PARAGRAPH * 3 + "\n\nEnd of the long report.").split())
SLOW_SECONDS = 6
SLOW_BACKGROUND_SECONDS = 7
LATEQ_SECONDS = 4
CHAT_TABS = ("Chats", "Tasks", "Computer", "Files")
PAIR_ATTEMPTS = 3
PAIR_WAIT = 40
# What the app shows when the link to the laptop is gone: the Offline banner ("Laptop offline · last contact ..", "Reconnecting to your laptop…")
# and the composer line "Offline. Your draft is saved ...".
OFFLINE_TEXT = r"Laptop offline.*|Reconnecting to your laptop.*|Offline\. Your draft is saved.*"
# cloudflared lines that show a dropped link or aborted requests. Some also appear on a normal client cancel, so a line alone never decides.
TUNNEL_LOG_BAD = re.compile(r"(Unable to reach the origin|Lost connection|connection with the edge|failed to serve|Unable to establish|Retrying connection|Request failed|ended abruptly|stream canceled)", re.I)


class Run:
    def __init__(self, a):
        self.a = a
        self.ev = a.evidence
        os.makedirs(f"{self.ev}/shots", exist_ok=True)
        self.d = Device(a.adb, self.note)
        self.t0 = time.time()
        self.results = []
        self.srvlog = f"{a.srv}/server.log"
        self.fakelog = f"{a.srv}/fake-pids/fake-claude.log"
        self.h = {}
        self.setup_reason = ""
        self.tlog_pos = os.path.getsize(a.tunnel_log) if a.tunnel_log and os.path.exists(a.tunnel_log) else 0

    def note(self, msg):
        line = f"{time.strftime('%H:%M:%S', time.gmtime())} {msg}"
        print(line, flush=True)
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
        for key, kw in (("back", {"desc": "Back"}), ("plus", {"rid": "composer-plus"}), ("send", {"desc": "Send"}), ("attach-add", {"rid": "attach-add"})):
            n = next((x for x in s.find(**kw) if x.clickable), None)
            if n:
                self.h[key] = n.center
        field = next((x for x in s.find(desc=r"Message .*…") if x.cls.endswith("EditText")), None)
        if field:
            self.h["field"] = field.center

    def tab(self, name):
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

    def reset(self):
        """Back to a known screen before every flow: close any menu, sheet or reply bar, drop leftover photos and draft text, then show the Chats tab.
        A flow that failed halfway (flow 9 with its reply bar open) must not turn the next flow red."""
        cleaned = []
        for _ in range(10):
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

    def tunnel_log_errors(self):
        """New cloudflared problem lines since the last look."""
        path = self.a.tunnel_log
        if not path or not os.path.exists(path):
            return []
        with open(path, "rb") as f:
            f.seek(self.tlog_pos)
            text = f.read().decode("utf-8", "replace")
            self.tlog_pos = f.tell()
        return [l for l in text.splitlines() if re.search(r"\b(ERR|WRN)\b", l) and TUNNEL_LOG_BAD.search(l)]

    def public_url_status(self):
        """http status of the throwaway server's environment route through the public tunnel URL, name resolved over 1.1.1.1 https. Never printed."""
        r = subprocess.run(["curl", "-s", "--doh-url", "https://1.1.1.1/dns-query", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6",
                            f"{self.a.link_host}/.well-known/t3/environment"], capture_output=True, text=True)
        return r.stdout.strip() or "none"

    def link_problem(self, full=False):
        """Why the link to the throwaway server looks lost, or None. Three signals: the tunnel unit is gone, the public URL does not answer twice
        in a row, or (only with full) the app shows its Offline banner while cloudflared logged aborted requests since the last look."""
        unit = self.a.tunnel_unit
        if unit and subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit]).returncode != 0:
            return f"the tunnel unit {unit} is not running"
        bad = self.tunnel_log_errors()
        code = self.public_url_status()
        if code != "200":
            time.sleep(3)
            code = self.public_url_status()
            if code != "200":
                return f"the public tunnel URL does not answer (http {code}); cloudflared logged {len(bad)} problem line(s)"
        if full and bad:
            try:
                s = self.d.dump()
            except Exception:
                return None
            banner = next((n.text for n in s.nodes if n.text and s.drawn(n) and re.fullmatch(OFFLINE_TEXT, n.text)), None)
            if banner:
                return f"the app shows its Offline banner ({banner[:40]!r}) and cloudflared logged {len(bad)} aborted request line(s): {bad[-1][-100:]!r}"
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
        self.learn(s)
        return s

    def say(self, bot, text, expect=None):
        before = len(self.fake_lines())
        self.d.tap_xy(*self.h["field"])
        time.sleep(0.3)
        self.d.type(text)
        self.d.key(111)
        time.sleep(0.4)
        self.d.tap_xy(*self.h["send"])
        if expect:
            retried = False
            for i in range(30):
                if any(expect in l for l in self.fake_lines()[before:]):
                    return
                if i == 10 and not retried:
                    # 3 s on and the bot has nothing: if the text is still sitting in the composer the Send tap did not fire (seen once in
                    # 9 runs, the tap landing while the keyboard was still closing). Tap once more and say so in the log.
                    field = self.composer_field(self.d.dump())
                    if field and text in field.text:
                        retried = True
                        self.note(f"send tap did not fire for {text!r}, tapping Send again")
                        self.d.tap_xy(*self.h["send"])
                time.sleep(0.3)
            raise AssertionError(f"the bot never received {expect!r}")

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
        d.sh(f"pm grant {PKG} android.permission.POST_NOTIFICATIONS")
        d.sh("cmd uimode night yes")
        d.sh("rm -f /sdcard/Pictures/verify-*.png")
        for name, tag in (("daily-red.png", "red"), ("daily-green.png", "green"), ("daily-blue.png", "blue")):
            d.run("push", f"{HERE}/photos/{name}", f"/sdcard/Pictures/verify-{tag}.png", check=True)
            d.sh(f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/verify-{tag}.png")
        d.run("logcat", "-c")
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
            raw = self.d.run("exec-out", "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml")
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
        self.say("Developer", "hello_verify", expect='prompt "hello_verify')
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
        self.say("Developer", "LONGMSG", expect="LONGMSG")
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
        self.say("Developer", "LPRESS", expect="LPRESS")
        s, ok = self.d.wait(lambda s: s.first(text=r"Idle .*") and next((x for x in s.find(desc="LPRESS") if x.clickable), None), 15)
        bubble = next((x for x in s.find(desc="LPRESS") if x.clickable), None)
        if not bubble or not s.first(text="LPRESS"):
            return "FAIL", "the sent message 'LPRESS' is not visible as a bubble"
        why, _ = self.long_press_reply(s, bubble, "You", lambda t: t == "LPRESS", "the sent message")
        if why:
            return "FAIL", why
        before = len(self.fake_lines())
        self.say("Developer", "LPQ", expect="LPQ")
        line = next(l for l in self.fake_lines()[before:] if "LPQ" in l)
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
        before = len(self.fake_lines())
        self.say("Developer", "PHOTOS3", expect="PHOTOS3")
        line = next(l for l in self.fake_lines()[before:] if "PHOTOS3" in l)
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
        offline = bool(s.first(text=r"Offline\. Your draft is saved.*") or next((n for n in s.nodes if n.text and s.drawn(n) and re.fullmatch(OFFLINE_TEXT, n.text)), None))
        bubble = bool(s.first(text=text) or s.first(desc=text))
        thumbs = len({n.desc for n in s.nodes if n.cls.endswith("ImageButton") and re.fullmatch(r".*\.(png|jpg)", n.desc) and s.drawn(n)})
        waiting = [n.text for n in s.nodes if n.text and s.drawn(n) and re.search(r"(?i)waiting|queued|sending|will send|not sent|failed", n.text)][:3]
        self.shot(f"probe-{tag}")
        return f"[{tag}] composer text={field.text if field else None!r} tray photos={previews} sent-thumbnails={thumbs} bubble with text={bubble} offline notice={offline} status texts={waiting}"

    def wait_arrival(self, tag, before, seconds):
        end = time.time() + seconds
        t0 = time.time()
        while time.time() < end:
            line = next((l for l in self.fake_lines()[before:] if tag in l), None)
            if line:
                return round(time.time() - t0, 1), len(re.findall(r'Attached image \\"[^"]+?\\" is saved at:', line))
            time.sleep(0.5)
        return None, 0

    def probe_offline_draft(self):
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
        self.d.tap_xy(*self.h["send"])
        secs, files = self.wait_arrival("BASE3", before, 90)
        log(f"C online baseline: the bot got BASE3 with {files} photos after {secs} s (None = never in 90 s)")
        self.reset(); self.open_bot("Developer")
        # B: airplane mode on the phone, then send, then network back
        compose("AIRPL3")
        self.d.sh("cmd connectivity airplane-mode enable")
        s, off = self.d.wait(lambda s: next((n for n in s.nodes if n.text and s.drawn(n) and re.fullmatch(OFFLINE_TEXT, n.text)), None), 60)
        log(self.draft_state("B-offline-before-send", "AIRPL3"))
        before = len(self.fake_lines())
        self.d.tap_xy(*self.h["send"])
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
        # A: the tunnel stops right after Send (the rig case, cloudflared aborts the requests)
        compose("TUNNEL3")
        log(self.draft_state("A-composed", "TUNNEL3"))
        before = len(self.fake_lines())
        self.d.tap_xy(*self.h["send"])
        subprocess.run(["systemctl", "--user", "stop", self.a.tunnel_unit])
        log("A: tunnel unit stopped right after tapping Send")
        s, off = self.d.wait(lambda s: next((n for n in s.nodes if n.text and s.drawn(n) and re.fullmatch(OFFLINE_TEXT, n.text)), None), 90)
        log(self.draft_state("A-after-tunnel-stop", "TUNNEL3"))
        secs, files = self.wait_arrival("TUNNEL3", before, 20)
        log(f"A: the bot got TUNNEL3 after {secs} s ({files} photos); None = nothing arrived (the link never came back: a quick tunnel gets a new URL)")
        with open(f"{self.ev}/probe-offline-draft.txt", "w") as f:
            f.write("\n".join(out) + "\n")

    def f4_seed(self):
        self.open_bot("Planner")
        self.say("Planner", f"LATEQ{LATEQ_SECONDS}", expect="LATEQ")
        self.leave_chat()
        self.open_bot("Researcher")
        self.say("Researcher", "CHOICES", expect="CHOICES")
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
        self.say("Developer", f"SLOW{SLOW_SECONDS}", expect="SLOW")
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
        self.say("Researcher", f"SLOW{SLOW_BACKGROUND_SECONDS}", expect="SLOW")
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

    def flows(self):
        order = [(1, "chat-send-reply", self.f1), (7, "swipe-quote", self.f7), (9, "long-press-reply", self.f9), (3, "camera-entry-once", self.f3), (2, "pick-three-photos", self.f2),
                 ("4s", None, self.f4_seed), (5, "in-app-on-tasks-tab", self.f5), (4, "work-card-unread-only", self.f4), (6, "background-goes-push", self.f6), (8, "open-and-back-logcat-clean", self.f8)]
        only = set(self.a.only.split(",")) if self.a.only else None
        seed_secs = 0
        self.order = order
        ran = []
        for flow, name, fn in order:
            if only and str(flow).rstrip("s") not in only:
                continue
            ran.append(flow)
            try:
                self.reset()
            except Exception as e:
                self.note(f"reset before flow {flow} failed: {type(e).__name__}: {str(e)[:120]}")
            prob = self.link_problem()
            if prob:
                self.link_lost(flow, name, prob, ran)
                return
            t = time.time()
            if flow == "4s":
                try:
                    fn()
                except Exception as e:
                    self.note(f"seed for flow 4 failed: {type(e).__name__}: {e}")
                seed_secs = time.time() - t
                continue
            try:
                verdict, reason = fn()
            except Exception as e:
                verdict, reason = "FAIL", f"{type(e).__name__}: {str(e)[:160]}"
            secs = time.time() - t + (seed_secs if flow == 4 else 0)
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

    def link_lost(self, flow, name, prob, ran):
        """The link to the throwaway server dropped. That is a setup failure (exit 2), never a flow FAIL: flows after this one are not judged."""
        only = set(self.a.only.split(",")) if self.a.only else None
        done = {str(x[0]) for x in self.results}
        left = [str(f) for f, _, _ in self.order if f != "4s" and str(f) not in done and (not only or str(f) in only)]
        self.setup_reason = f"link to the throwaway server lost at flow {flow} ({name}): {prob}. Rig or tunnel connection dropped, not an app verdict. Flows {','.join(left)} not judged. Rerun."
        self.note(f"LINK LOST: {self.setup_reason}")
        self.shot(f"link-lost-f{flow}")


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
    r = Run(a)
    try:
        r.setup()
    except Exception as e:
        r.note(f"SETUP FAILED: {type(e).__name__}: {e}")
        open(f"{r.ev}/setup-reason.txt", "w").write(f"{type(e).__name__}: {str(e)[:160]}\n")
        r.save_diag("setup-fail")
        return 2
    if a.probe == "offline-draft":
        r.probe_offline_draft()
        return 0
    t = time.time()
    r.flows()
    total = time.time() - t
    fails = [x for x in r.results if x[2] != "PASS"]
    json.dump({"version": r.version, "flows_seconds": round(total), "setup_reason": r.setup_reason, "results": [dict(zip(("flow", "name", "verdict", "reason", "secs"), x)) for x in r.results]}, open(f"{r.ev}/drive.json", "w"), indent=1)
    if r.setup_reason:
        open(f"{r.ev}/setup-reason.txt", "w").write(r.setup_reason + "\n")
        r.note(f"SETUP FAILED (exit 2): {r.setup_reason}")
        return 2
    r.note(f"DONE {len(r.results) - len(fails)} PASS, {len(fails)} FAIL, flows {total:.0f} s")
    return 1 if fails or not r.results else 0


if __name__ == "__main__":
    sys.exit(main())
