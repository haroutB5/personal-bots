# hbots 1.66.84: the right effort choices per model, and OpenCode's API price

Two follow-ups from the OpenCode Go work. The effort picker offered levels a model does not accept, and the usage card had no dollar figure.

## Changes

- **Effort choices now come from each model.** OpenCode's session options describe only the model the session starts on, so the probe used to copy that one model's effort list onto all 69 models. That is why DeepSeek appeared to offer Medium and Xhigh: it does not. The probe now asks each model for its own options (69 local switches, about 0.2 s), and the picker shows DeepSeek's real list, low / high / max / Default. Claude and GPT models keep their own longer lists.
- **An invalid saved effort no longer fails a turn.** A bot selection made before this release (for example Backend's Medium, or the fallback Medium on IT, Frontend and DevOps) is checked against the model's offered values before it is sent. An unsupported value is left unset, so the model runs at its own default, and one WARN records it. The form no longer offers values the model does not accept.
- **OpenCode shows its API price in the usage sheet.** Under the Go windows the OpenCode card now shows the week's API-price value of the tokens we recorded, from the same scan as the Token usage card: `API price $0.79 this week`, with `plus unpriced tokens` when some models have no list rate. It is the list-price equivalent, not a charge: Go is a flat subscription and the allowance windows above it are the real limit. No figure is shown until the scan has one, never an invented zero.
- No schema change, no provider settings change, task concurrency stays 5.

## Validation

- Real Go Plus adapter run passed with the new per-model probe: the DeepSeek model's snapshot now lists exactly `low`, `high`, `max`, `default`, and the persona, resume, tools and approval checks from 1.66.82 still pass.
- Focused server tests: the effort is applied when offered, and an unsupported `medium` on a DeepSeek-shaped list is skipped instead of sent (8 tests).
- Focused web tests: the spend line with and without unpriced tokens, and the usage sheet still renders (70 tests).
- Server and web typechecks passed; changed-file lint and formatting passed (three existing effect-dependency warnings in the strip, no errors).

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `a3b1655e940b` (binary only) if the smoke fails. After the restart the OpenCode provider snapshot is rebuilt with the per-model effort lists; Backend, IT, Frontend and DevOps keep their saved selections and run without the invalid Medium.
