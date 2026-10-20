# HANDOFF 1.66.73

Bots can run on Antigravity (Gemini 4 Argon, Gemini 3.8 Flash). Built by CTO
as a hotfix. No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `hotfix/hbots-16673-antigravity-bots`, cut from `personal-bots/main`
`713302bea5` (live 1.66.72 `1aeb673228da`). Code commit `fd26160e3f`.

## 1. Antigravity in the bot form

Harout, 20 Oct: "I need the gemini models in bots asap. Currently i cant
chose any". Antigravity was signed in on live (Google AI Pro, models Gemini 4
Argon low/medium/high and Gemini 3.8 Flash) but the bot form never offered
it: it only lists providers whose adapter passes the bot's persona
(`BOT_INSTRUCTION_DRIVER_KINDS`, checked against the adapter sources by
`botInstructionCoverage`), and the Antigravity adapter appended only the
runtime notes to each prompt.

- `AntigravityAdapter.sendTurn` now sends
  `withBotInstructions(buildRuntimeInstructions(...), input.systemInstructions)`
  in the text block it already adds to every prompt. Every turn carries the
  bot's name, instructions and app rules, so an edit takes effect on the next
  turn. The t3-code MCP server was already passed to Antigravity sessions.
- `antigravity` joins `BOT_INSTRUCTION_DRIVER_KINDS`; the bot form's
  "no provider" copy names it.
- Follow-up (not this release): Antigravity 1.4.0 advertises
  `_meta.antigravity.systemPrompt.append` at initialize; moving the persona
  there would stop repeating it in every prompt. Not used yet because the
  request format could not be verified tonight (the laptop was out of memory
  and the probe never got past startup).

## 2. Tests

PROOF_PLACEHOLDER

## 3. Risks

- The persona is part of every prompt's text, so long bot instructions cost
  input tokens on every Antigravity turn (counted against Harout's Google AI
  Pro quota).
- Adapter change is one text block; other drivers unchanged.
