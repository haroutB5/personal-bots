# Eco mode: follow-ups after release

From Fable's release review of the eco-mode branch (verdict SHIP AFTER FIXES). The must-fixes and small fixes landed on the branch; these were left for after release.

- **An interrupt mid-handoff can end the turn on the builder (review item 4).** An interrupt closes the Claude process, so the next turn opens a fresh one on the planner (covered by the "interrupted before/during/after the handoff" adapter tests). What is not covered: a turn that ends another way while the builder switch is still in flight on a process that stays alive. The turn-end restore now always sends `setModel(planner)` after the builder's, but the turn's last calls can still run on the builder and be counted on the builder side.
- **The cost columns leave out other models (review item 6).** `personal_eco_turns` has planner and builder columns only. A call on a third model (Haiku for Claude Code's own side calls, or a planner subagent running on Sonnet) goes into `other` in `sdk_cost_usd_json` and `calls_json`, not into either side's tokens or cost. A per-model breakdown, or an `other_cost_usd` column, would make the totals add up.
- **Alternating Eco and ordinary turns restarts the process (review item 7).** An Eco turn needs a process with `eco_handoff` and the edit guard, and an ordinary turn needs one without, so a thread that alternates (a task, then a chat, then a task) opens a new Claude process at each switch, losing the warm cache. Keeping one Eco-capable process and letting the guard and the handoff act per turn (as they already do on an Eco process for an ordinary turn with background work) would avoid it.

Also noted while fixing:

- "Cheaper" in the bot form is the known Claude order (Opus > Sonnet > Haiku); the provider model list carries no prices. An unknown family (Fable, a custom model) is not checked.
- The Bash guard is a hint for the planner, not a sandbox: `python -c` / `node -e` code is matched against common file-writing calls, and a `subprocess` / `os.system` call that runs another command is not inspected.

From Fable's final review (round 2, SHIP), left for after 1.67.64:

- **Saving an Eco-on bot before the providers list has loaded switches Eco off silently** (`packages/personal-client/src/bots/botDraft.ts:449`). `botOffersEco` gets `undefined` for the provider while the list is still loading, so the save sends `{ enabled: false }` for a bot whose saved Eco is on. Fix: send nothing for Eco when the provider is unknown (only switch Eco off when the provider is known and has no Eco).
