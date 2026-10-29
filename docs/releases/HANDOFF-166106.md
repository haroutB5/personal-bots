# 1.66.106: repeated question answers

Based on 1.66.105 via personal-bots/main (12e38e699a). No migration; schema remains 114. When a message-mode question ID is reused, each answer now has a distinct activity and message ID tied to its command. The previous answer remains intact and the next turn references the new message. Existing synchronous question handling is unchanged.

The screen retains only the newest card when an ID is reused. Preserving both needs changes to its request history and resolution matching, beyond this contained server fix.

Targeted checks: 39 server tests passed, including reused ID, supersede and stale tap; 10 web question-card tests passed, including newest-request matching. Two focused provider reactor tests passed. The staged release was exercised with QA's fake-Codex repeated-ID repro: the provider received `Which option?\nOne`, then `Which option?\nTwo`. Evidence: `/tmp/hbots-16706-target-server.log`, `/tmp/hbots-16706-target-web.log`, `/tmp/hbots-16706-target-reactor.log`, `/tmp/hbots-16706-repro/mock/peer.log`, and `/tmp/hbots-16706-build.log`.

The full gate passed with 2,851 server tests (six skipped), 3,123 web tests, both typechecks and five browser journeys. Its evidence and logs are in `/home/harout/.personal-bots/releases/14c01ddc78e7/`.

## Gate evidence

<!-- gate-evidence:begin sha=14c01ddc78e7616644001c7e024e93f0188dad51 release=14c01ddc78e7 json-sha256=94a78596e84b9742b56432465ef6c87430980671de9032b29e79e27af7f42e62 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
