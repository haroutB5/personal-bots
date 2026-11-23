"""Unit tests for the pure parts of drive.py. Run: python3 -I -m unittest scripts/test_drive.py (from the skill folder). No device needed."""
import os
import re
import sys
import tempfile
import types
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drive  # noqa: E402
from ui import Node, Screen  # noqa: E402
import xml.etree.ElementTree as ET  # noqa: E402


def screen(*items):
    """items: (text, desc, clickable). Each node is drawn inside the 1080x2355 screen."""
    nodes = [Node(ET.fromstring(f'<node text="{t}" content-desc="{d}" resource-id="" class="android.widget.TextView" clickable="{str(c).lower()}" enabled="true" bounds="[10,{100 + 100 * i}][500,{180 + 100 * i}]"/>')) for i, (t, d, c) in enumerate(items)]
    return Screen(nodes, 1080, 2355)


class PromptText(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(drive.prompt_text('2026 1 prompt "SLOW6"'), "SLOW6")

    def test_substring_is_not_equal(self):
        self.assertNotEqual(drive.prompt_text('2026 1 prompt "PLANTDRASLOW6FT"'), "SLOW6")

    def test_reply_quote_and_photos_taken_off(self):
        line = r'x prompt "   PHOTOS3\n\n[Attached image \"16.png\" is saved at: /a/b.png]\n\n[Attached image \"17.png\" is saved at: /a/c.png]"'
        self.assertEqual(drive.prompt_text(line), "PHOTOS3")
        self.assertEqual(drive.prompt_text(r'x prompt "[Replying to my earlier message: \"LPRESS\"]\n\nLPQ"'), "LPQ")

    def test_other_lines(self):
        self.assertIsNone(drive.prompt_text("x fakeok handles prompt"))


class OfflineText(unittest.TestCase):
    def test_banner_strings_from_offlineBanner_ts(self):
        for t in ("Laptop offline", "Laptop offline · last contact 5m ago", "Reconnecting to your laptop…", "Messages you send will go out when it reconnects.",
                  "1 message is waiting to send. It goes out when it reconnects.", "3 messages are waiting to send. They go out when it reconnects."):
            self.assertTrue(re.fullmatch(drive.OFFLINE_TEXT, t), t)

    def test_composer_line_matches_by_its_start_for_either_copy(self):
        for t in ("Offline. Your draft is saved and sends when the laptop is back.", "Offline. Messages you send now go out when the laptop is back."):
            self.assertTrue(re.fullmatch(drive.OFFLINE_TEXT, t), t)

    def test_online_texts_are_not_offline(self):
        for t in ("Chats", "Idle · Sonnet 5.5", "Not sent", "Message Developer…", "Laptop", "Offline mode off"):
            self.assertFalse(re.fullmatch(drive.OFFLINE_TEXT, t), t)

    def test_send_desc(self):
        self.assertTrue(re.fullmatch(drive.SEND_DESC, "Send"))
        self.assertTrue(re.fullmatch(drive.SEND_DESC, "Send, waits here until your laptop reconnects"))
        self.assertFalse(re.fullmatch(drive.SEND_DESC, "Sending photos"))


class LinkProblem(unittest.TestCase):
    def run_with(self, log_lines, scr):
        scratch = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".scratch")
        os.makedirs(scratch, exist_ok=True)
        td = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(td.cleanup)
        tmp = td.name
        log = os.path.join(tmp, "tunnel.log")
        with open(log, "w") as f:
            f.write("2026 INF started\n")
        a = types.SimpleNamespace(evidence=tmp, adb="adb", srv=tmp, tunnel_log=log, tunnel_unit="", link_host="https://x.invalid", only="")
        os.environ["VERIFY_STDOUT_TEED"] = "1"
        r = drive.Run(a)
        with open(log, "a") as f:
            f.write("".join(l + "\n" for l in log_lines))
        r.public_url_status = lambda: "200"
        r.d = types.SimpleNamespace(dump=lambda: scr)
        with unittest.mock.patch.object(drive.time, "sleep", lambda s: None):
            return r.link_problem(full=True)

    def test_serve_error_in_flow_is_link_lost(self):
        why = self.run_with(["2026 ERR Serve tunnel error error=\"accept stream listener error: ... no recent network activity\" connIndex=0",
                             "2026 INF Retrying connection in up to 2s connIndex=0"], screen(("Chats", "", False)))
        self.assertIn("dropped-tunnel", why)

    def test_retry_line_alone_at_info_level(self):
        self.assertIn("dropped-tunnel", self.run_with(["2026 INF Retrying connection in up to 2s"], screen()))

    def test_not_sent_with_offline_banner(self):
        why = self.run_with([], screen(("Not sent", "", False), ("Laptop offline", "", False)))
        self.assertIn("Not sent", why)

    def test_not_sent_with_the_composer_offline_line_in_a_chat(self):
        why = self.run_with([], screen(("Not sent", "", False), ("Offline. Messages you send now go out when the laptop is back.", "", False)))
        self.assertIn("Not sent", why)

    def test_not_sent_alone_is_a_failure(self):
        self.assertIsNone(self.run_with([], screen(("Not sent", "", False))))

    def test_real_failure_with_a_quiet_link_stays_a_failure(self):
        self.assertIsNone(self.run_with(["2026 INF Registered tunnel connection"], screen(("Chats", "", False))))

    def test_cancel_line_without_banner_is_not_a_link_loss(self):
        self.assertIsNone(self.run_with(["2026 ERR Request failed error=\"stream canceled\""], screen(("Chats", "", False))))

    def test_aborted_lines_with_banner(self):
        self.assertIn("aborted", self.run_with(["2026 ERR Request failed error=\"stream canceled\""], screen(("Reconnecting to your laptop…", "", False))))


class F10Overlap(unittest.TestCase):
    ORDER = [(f, str(f), None) for f in (1, 7, 9, 3, 2, "4s", 5, 4, 6, 8, 10, 11, 12, 13, 14)]
    START = ("10t", "start", None)

    def test_timeout_start_then_fillers_then_the_rest(self):
        got = [e[0] for e in drive.overlap_order(self.ORDER, self.START)]
        self.assertEqual(got, ["10t", 1, 7, 9, 3, 2, 11, 12, 13, "4s", 5, 4, 6, 8, 10, 14])

    def test_fillers_keep_out_of_the_pending_card(self):
        # 4 and 8 (Work tab needs-you bar), 5 (Tasks tab: no bot working), 6 (push in the background) and
        # 14 (Bots order) would see the pending approval; flow 10's own legs run after the decline.
        self.assertEqual(set(drive.F10_FILLERS) & {4, 5, 6, 8, 10, 14}, set())
        self.assertNotEqual(drive.F10_TIMEOUT_BOT, "Developer", "every Developer-chat flow is a filler")
        self.assertEqual(set(drive.F10_TYPICAL), set(drive.F10_FILLERS))
        self.assertLess(drive.F10_DECLINE_AT, 120, "a filler must end before the server's 2 minutes")

    def test_order_without_fillers(self):
        order = [e for e in self.ORDER if e[0] not in drive.F10_FILLERS]
        self.assertEqual(drive.overlap_order(order, self.START), [self.START] + order)


if __name__ == "__main__":
    unittest.main()
