# hbots 1.66.92: an Antigravity unknown model reads "Unknown model"

Live QA of 1.66.91 failed one wording criterion on the Team token usage card: a payload row with provider `antigravity` and model id `antigravity-unknown` rendered **Antigravity · Unknown**, not **Antigravity · Unknown model**. The model id was title-cased to `Antigravity Unknown`; normalisation only recognised a bare `Unknown`, and removing the provider word that the card already prints then left `Unknown`. This release widens the placeholder check so the provider-prefixed form is named too. Nothing else about the card changes.

## Changes

- **`normalizeModelName` matches the end of the name.** Any id or display name that ends in the word `unknown` (case-insensitive, separated by whitespace, `-`, `_` or `/`) becomes `Unknown model`. That covers a bare `Unknown`, the raw id `antigravity-unknown`, and an already title-cased `Antigravity Unknown`. A real model name that only contains `Unknown` elsewhere, such as `Unknown Things 2`, is left unchanged.
- **The provider prefix is still removed afterwards, and now finds nothing to remove.** `withoutProviderPrefix("Antigravity", "Unknown model")` returns `Unknown model`, so the line is exactly `Antigravity · Unknown model`. Real models are untouched: `DeepSeek V4.1 Flash` keeps its brand casing, `Gemini 3.8 Flash N` stays as it was, and the GPT route form still applies.
- **Unit coverage** pins bare `unknown`, `antigravity-unknown`, `Antigravity Unknown`, `Gemini 3.8 Flash N` and `Unknown Things 2`, and the full table build asserts the `Antigravity · Unknown model` label with its tokens and price intact.
- **The live defect this fixes.** Live 1.66.91 QA report `C:\Users\Ht\.personal-bots\qa\hbots-16691-live\REPORT.md` criterion 5 and screenshot `C:\Users\Ht\.personal-bots\qa\hbots-16691-live\04-token-models-live.png`: the Frontend 7-day row reads `Antigravity · Unknown` with `1.1M · not priced`. The unmodified live token response carries provider `antigravity`, model `antigravity-unknown`.
- No server or contract change, no migration, no settings change; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Validation

- Targeted web unit tests: `tokenUsagePresentation.test.ts` 31 of 31, exit 0, including bare `Unknown`, `antigravity-unknown`, `Antigravity Unknown`, `Gemini 3.8 Flash N` and `Unknown Things 2`, plus the full table build asserting `Antigravity · Unknown model`.
- Full personal web suite: 3032 of 3032 tests in 266 files, exit 0. Web `tsc --noEmit`: exit 0. Both were run again by the gate from a clean tree; the gate counts are in its section below.
- Throwaway server from the staged release `e906462e6c37`, 390x844 dark, fresh isolated root `%TEMP%\hbots-tw-16692`, the exact live 1.66.91 Frontend 7-day payload fed through the real `personalBots.tokenUsage` RPC (provider `antigravity`, model `antigravity-unknown`, 1.1M tokens, unpriced). The card reads exactly `Antigravity · Unknown model` with `1.1M · not priced`; the other six rows are byte-identical to live (`Claude · Sonnet 5.5 992.0M · $143.00`, `OpenCode · DeepSeek V4.1 Flash 458.1M · $2.88`, `Antigravity · Gemini 3.8 Flash N 219.1M · $23.42`, `Codex · GPT-6-Luna 208.0M · $3.35`, `Codex · GPT-6.1-Sol 76.5M · $11.04`, `Antigravity · Gemini 3.8 Flash High 49.6k · $0.01`), there is no bare `Antigravity · Unknown` anywhere, the page has no horizontal overflow, and there are no uncaught page errors. 12 of 12 checks pass (`C:\Users\Ht\.personal-bots\qa\hbots-16692\VERIFY.json`).
- Screenshots (dark 390x844): `C:\Users\Ht\.personal-bots\qa\hbots-16692\01-token-unknown-model-390-dark.png` (card at the Frontend row), `02-token-card-390-dark.png`, `03-frontend-row-390-dark.png`.
- Live 1.66.91 was not touched: `releases\current.txt` was `35579bd5ae65` before and after this work, no deploy or restart ran, and the 1.66.90/1.66.91 release folders were not modified.

## Runtime and activation

No migration (112 to 112), so no production backup. Roll back to 1.66.91 `35579bd5ae65` (binary only) if the smoke fails. Node stays at 24.22.1. The web client is the whole change; the server bundle is rebuilt unchanged.
