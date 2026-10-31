# 1.66.109: Antigravity Gemini session and weekly usage limits, plus P19 ultrathink disable

Based on 1.66.108 (`a1388a74b2`). Branch `fix/hbots-16708`. No migration; schema remains 114. Server only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Harout reported: "Fix the anti-gravity session usage not showing. Im using Gemini but it's still on 0", with a screenshot of the Usage sheet showing Antigravity with only one row (`Gemini · Weekly 0% used · Resets 16:28 · resets in 5h 0m`) and no `Gemini · 5-hour session` row.

## Root causes

1. **Missing `Gemini · 5-hour session` row (5h session misclassified as Weekly):** `readAntigravityUsageLimits` recorded `checkedAt` before the OAuth token refresh and CCPA HTTP round-trips. On untouched 5-hour rolling buckets, Google's CCPA server stamps `resetTime = server_now + 5h`, which is 1 to 2 seconds after `checkedAt + 5h` (`resetMs - checkedMs` was ~5h 0m 1.7s > `FIVE_HOURS_MS`). `antigravityUsageToLimits` treated any reset strictly greater than `5 * 60 * 60_000` ms as `bindingWeekly = true`, relabelled the 5-hour session window as `Gemini · Weekly` (with the 5h reset time), and returned early with only that single row.
2. **Usage still showing `0%` while using Gemini 4 Argon:** `readAntigravityUsageLimits` sent `User-Agent: antigravity/1.4.0` instead of the structured aidev `User-Agent` that the Antigravity ACP runtime sends (`antigravity/acp/1.4.0 (aidev_client; os_type=linux; arch=amd64; host_path=unknown/unknown; proxy_client=antigravity/sdk)` from `useragent.py` in `agy_acp_server.par`). Without `aidev_client`, Google's CCPA backend (`daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`) does not attribute the request to `ClientType_ANTIGRAVITY` and omits `gemini-4-argon-*` from `fetchAvailableModels` as well as the `Gemini Models` and `Gemini 4 Argon` groups from `retrieveUserQuotaSummary`. It only returned the untouched `gemini-3.8-flash` / `gemini-2.5-*` models (`remainingFraction: 1`), so usage read `0%`.
3. **Separate session and weekly buckets on Google AI Pro:** On Google AI Pro, Gemini 3.8 Flash / 2.5 Pro report a 5-hour session reset in `fetchAvailableModels` while Gemini 4 Argon has its own weekly bucket (`gemini-4-argon-*` in `fetchAvailableModels` and `Gemini 4 Argon` -> `gemini-argon-wtu-weekly` in `retrieveUserQuotaSummary`). Previously `antigravityUsageToLimits` picked only a single tightest model overall instead of splitting per-model entries into session (reset within 5h + 10m clock-skew margin) and weekly (reset further out), and `antigravityQuotaSummaryToLimits` only checked the first `gemini` group (`Gemini Models`) and missed `Gemini 4 Argon`.

## What changed

- `apps/server/src/provider/Layers/antigravityUsageLimits.ts`:
  - Sends `ANTIGRAVITY_CCPA_USER_AGENT` (`antigravity/acp/1.4.0 (aidev_client; os_type=linux; arch=amd64; host_path=unknown/unknown; proxy_client=antigravity/sdk)`) and `{ metadata: { ideType: "ANTIGRAVITY" } }` on `loadCodeAssist`, matching `agy_acp_server.par`.
  - Uses `SESSION_WINDOW_MAX_MS = FIVE_HOURS_MS + 10 * 60_000` (5h 10m) so a 5-hour rolling reset stamped a few seconds after `checkedAt` stays on `gemini-session` instead of misclassifying as `gemini-weekly`.
  - Splits per-model Gemini entries into session (`!isWeekly`) and weekly (`isWeekly`) buckets, taking the tightest model in each bucket and merging with any tighter reading from `retrieveUserQuotaSummary`.
  - Aggregates buckets across all Gemini groups (`Gemini Models` and `Gemini 4 Argon`) in `antigravityQuotaSummaryToLimits`, picking the tightest 5h bucket for `gemini-session` and the tightest weekly bucket for `gemini-weekly`.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (folded from nightly P19 commit `a0d22198c1`):
  - Sets `CLAUDE_CODE_DISABLE_ULTRATHINK=1` in Claude bot sessions so the `ultrathink` keyword in prompts does not raise a bot turn to xhigh effort; owner chats keep the keyword.

## Verification

- Live probe against Google's CCPA endpoints with the active Antigravity profile returned both windows: `gemini-session` (`Gemini · 5-hour session`, `0% used`, `resetsAt: 2026-10-31T16:53:46Z`) and `gemini-weekly` (`Gemini · Weekly`, `52% used`, `resetsAt: 2026-11-07T10:54:16Z`).
- Unit tests in `apps/server/src/provider/Layers/antigravityUsageLimits.test.ts` (16 passing) and `AntigravityDriver.test.ts` (13 passing).

## Gate evidence

<!-- gate-evidence:begin sha=f32ce61e056a4075418fece88d7cc074213dd04b release=f32ce61e056a json-sha256=755e8b47ece3695cf125a06d3de7f8f344e8099691daeb5a616b680213aae99b result=PASS -->

- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- server-tests: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
