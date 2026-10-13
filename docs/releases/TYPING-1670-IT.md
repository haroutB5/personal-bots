# Targeted typing/filter investigation — 13 October 2026

No performance change cleared the shipping proof. All trials are reverted;
the final branch has no runtime difference from release base b8f9693be9.
This report is the only retained change. Do not activate the trial artifacts
b1c74547b4d2 or 245bd0ef9004.

The scope was only typing and filtering at 390 px, dark mode, Chromium at 4x
CPU, five interleaved pairs against live release b03c41d7853b. Long Forge chat
opening/scrolling was untimed setup. Back/remounts and the other journeys were
not measured. No full speed pass was repeated.

| Last tested head 245bd0ef9004 | Live baseline | Trial | Verdict          |
| ----------------------------- | ------------: | ----: | ---------------- |
| Filter paint, median ms       |          10.0 |  85.0 | WORSE, 4/5 pairs |
| Typing per-key median ms      |          13.4 |  12.6 | ok               |
| Typing per-key p95 ms         |          23.4 | 315.1 | WORSE, 3/5 pairs |
| Typing long-task ms           |             0 |     0 | ok               |

Trials and decisions:

- `composer-caret`: skip unused caret state in ordinary bot composers;
  mention-enabled group composers retained their original path.
- `composer-measure-contain`: contain the invisible sizing textarea's layout.
- `home-search-sync`: avoid rendering stale search results before the narrowed
  results. Same-build diagnostic: home renders 2→1, filter commits 4→3.
- `home-filter-layout`: skip a geometry read when every filtered result is
  already drawn. Same-build diagnostic: list rect reads 1→0.
- The combined trial b1c74547b4d2 passed a corrected five-pair filter median
  of 6.0→5.1 ms but typing p95 remained 19.8→302.3 ms (WORSE, 5/5).
  Typing commits fell 81→54 in the same-build diagnostic, with differing
  background chat-screen update counts. Both composer trials were rejected.
- The home-only trial 245bd0ef9004 then produced the table above. Its earlier
  filter gain was not reproduced, so both home trials were also rejected.
- The equivalent heading token cleanup and the added regression tests were
  reverted with the home trials. No update-line or push-notice code was changed.

Trial gates passed: 114 focused tests across PersonalComposer, ChatsScreen and
useHomeWindow, web typecheck, scoped lint (existing React warnings), and exact
web/server builds without activation. Chromium/WebKit checks passed: eight
composer screenshots were pixel-identical with flags off/on; wrapping, height,
caret, latest-message pinning, and narrowed/empty/cleared results matched.
These checks establish behavior preservation, not acceptable speed.

The first five-pair run was discarded: the shared QA probe permits a queued
pre-input frame timestamp and clamps negative filter durations to zero. The
local probe requires frameAt >= input t0 on both sides. No budget or shared QA
file was changed. Machine pressure also varied: the final candidate slot had
530 MB minimum free RAM and 55.7% maximum CPU. Neither noisy measurements nor
fewer commits justify a speed clearance.

The remaining typing cause is not isolated. Traces include background chat
screen/transcript work and first-time syntax/highlighter warmup. After the
redesign is live, separate input→commit→layout→paint timing from background
updates using consistent warmed fixtures; investigate the large p95 delays
before proposing another change. Do not reuse these results as a full-release
performance verdict.

Evidence: C:/Users/Ht/.personal-bots/qa/hbots-1670/typing-it/
(`compare-final.log`, `compare-corrected.log`, `compare-stale-frame.log`,
`renders-off.json`, `renders-on.json`, `visual-check.json`, gate/build logs,
and the corrected local probe/harness). The original QA result JSON/Markdown
files remain under qa/results.

Cleanup: both owned throwaway servers were downed, owned proof/build/install
processes finished, ports 58961/57260 no longer listen, and the measurement lock
was released. Fixtures/evidence remain for reproducibility. No live server,
remote connection, or other bot's processes were interrupted.
