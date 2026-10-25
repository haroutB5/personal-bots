# hbots 1.66.92: an Antigravity unknown model reads "Unknown model"

Live QA of 1.66.91 failed one wording criterion on the Team token usage card: a payload row with provider `antigravity` and model id `antigravity-unknown` rendered **Antigravity · Unknown**, not **Antigravity · Unknown model**. The model id was title-cased to `Antigravity Unknown`; normalisation only recognised a bare `Unknown`, and removing the provider word that the card already prints then left `Unknown`. This release widens the placeholder check so the provider-prefixed form is named too. Nothing else about the card changes.

## Changes

- **`normalizeModelName` matches the end of the name.** Any id or display name that ends in the word `unknown` (case-insensitive, separated by whitespace, `-`, `_` or `/`) becomes `Unknown model`. That covers a bare `Unknown`, the raw id `antigravity-unknown`, and an already title-cased `Antigravity Unknown`. A real model name that only contains `Unknown` elsewhere, such as `Unknown Things 2`, is left unchanged.
- **The provider prefix is still removed afterwards, and now finds nothing to remove.** `withoutProviderPrefix("Antigravity", "Unknown model")` returns `Unknown model`, so the line is exactly `Antigravity · Unknown model`. Real models are untouched: `DeepSeek V4.1 Flash` keeps its brand casing, `Gemini 3.8 Flash N` stays as it was, and the GPT route form still applies.
- **Unit coverage** pins bare `unknown`, `antigravity-unknown`, `Antigravity Unknown`, `Gemini 3.8 Flash N` and `Unknown Things 2`, and the full table build asserts the `Antigravity · Unknown model` label with its tokens and price intact.
- **The live defect this fixes.** Live 1.66.91 QA report `C:\Users\Ht\.personal-bots\qa\hbots-16691-live\REPORT.md` criterion 5 and screenshot `C:\Users\Ht\.personal-bots\qa\hbots-16691-live\04-token-models-live.png`: the Frontend 7-day row reads `Antigravity · Unknown` with `1.1M · not priced`. The unmodified live token response carries provider `antigravity`, model `antigravity-unknown`.
- No server or contract change, no migration, no settings change; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Validation

- Targeted web unit tests: `tokenUsagePresentation.test.ts` passes, including the new cases.
- Full personal web suite and web `tsc --noEmit` were run from a clean tree for this release; the exact counts and exit codes are recorded in the Gate evidence section written by `gate-evidence.ps1`.
- Throwaway server from the staged release, 390x844 dark, fresh isolated root, usage fixture with provider `antigravity` and model `antigravity-unknown`: the token card reads exactly `Antigravity · Unknown model` with `1.1M · not priced`, every other row is unchanged, and the page has no horizontal overflow. Screenshot: `C:\Users\Ht\.personal-bots\qa\hbots-16692\01-token-unknown-model-390-dark.png`.
- Live 1.66.91 was not touched: no deploy, no restart, no change to `releases\current.txt` or the 1.66.90/1.66.91 release folders.

## Runtime and activation

No migration (112 to 112), so no production backup. Roll back to 1.66.91 `35579bd5ae65` (binary only) if the smoke fails. Node stays at 24.22.1. The web client is the whole change; the server bundle is rebuilt unchanged.
