# 1.67.64: Eco mode v1 (plan on the bot's model, build on a cheaper one)

Based on 1.67.63 (trunk `6828923178`, live release `43671862d41e`). Branch `eco-mode`, built in worktree `_wt/hbots-eco`. **Migration 165** `PersonalEcoMode` (schema 164 -> 165, additive: two `ADD COLUMN`s on `personal_bots`, a new `personal_eco_turns` table and an index), so the release runner takes the pre-migration backup (`--migration-before 164 --migration-after 165`). **Phone release:** the Android bot form gains the Eco section (`BotEcoSection`, form rules), so a new arm64 APK is built and `latest.json` moves to 1.67.64. Eco is off by default for every bot; no new config or env.

Reviewed by Fable (two rounds, final verdict SHIP, no blocking regression). Built by Opuser, approved by Opusito.

## What changed

- **Eco mode v1** (`d292e7f5aa` and fixes through `c0f26585ef`): a Claude bot with Eco on plans on its own model, then hands the build to a cheaper builder model (default Sonnet 5.5 on the bot's instance) through an `eco_handoff` tool; the planner gets an edit guard (including a Bash guard for scripted writes, scratch output allowed). Eco is part of the Claude process reuse identity; the planner model and effort are restored at turn end; Eco is skipped (recorded as `eco_skipped`) when the saved builder no longer fits or an earlier turn left background work.
- **Cost record:** each Eco turn writes a `personal_eco_turns` row with planner and builder calls, tokens and cost, each call priced at its own rates, output counts from `message_delta`; dropped cost rows are logged.
- **Bot form (web and Android):** Eco switch and builder model/effort; Eco switches off on a non-Claude provider and requires a cheaper builder and its effort.
- **Contracts and parity:** Eco fields in `packages/contracts/src/personalBots.ts`; parity line refs refreshed.
- **Version:** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` bumped to `1.67.64`.

## Release notes for the phone

Bots can now use Eco mode: plan on the bot's own model and build on a cheaper one. It is off for every bot until you switch it on in the bot's settings.

## Verification

Pending: stage, full gates and gate evidence on the staged release, arm64 APK, emulator QA.

## Follow-ups (not blocking 1.67.64)

See `docs/eco/follow-ups.md`; the newest is Fable's round-2 note that saving an Eco-on bot before the providers list has loaded switches Eco off silently (`botDraft.ts:449`).

## Migration

165 `PersonalEcoMode` (164 -> 165), additive only. The runner takes the pre-migration backup.

## Rollback

Binary rollback to 1.67.63 (`43671862d41e`). The new columns, table and index are additive and ignored by 1.67.63 (confirmed by Fable).
