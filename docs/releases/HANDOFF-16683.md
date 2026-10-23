# hbots 1.66.83: OpenCode Go in the usage dashboard

1.66.81 read the OpenCode Go allowance (rolling 5-hour, weekly, monthly) and kept it on the provider snapshot, but the usage dashboard only drew cards for Claude, Codex, DeepSeek and Antigravity. OpenCode's numbers were there and never shown. This release adds the card.

## Changes

- The Usage sheet now has an OpenCode card, built from the enabled OpenCode instance's Go windows: `Go · Session`, `Go · Weekly` and `Go · Monthly`, each with its used percent and reset. The sheet's subtitle names it, and the card appears only when an enabled OpenCode instance reports windows, so a turned-off instance adds nothing.
- The Chats-screen usage strip gets the OpenCode cell (session and weekly, the same shape as the other providers). With four providers it scrolls horizontally on a phone rather than squeezing the bars.
- A turned-off OpenCode instance is ignored when several share the driver; the newest enabled one supplies the card. This is why the disabled v1 entry does not hide the v2 numbers.
- No schema change, no provider or adapter change, task concurrency stays 5.

## Validation

- Focused web tests: the OpenCode card from three Go windows (session, weekly, monthly), the disabled v1 instance ignored in favour of `opencode-v2`, and the sheet subtitle `Token windows for OpenCode`. 83 tests passed across the usage presentation, strip and strip component suites.
- Web typecheck passed; changed-file lint and formatting passed.
- The live Go usage endpoint answered 200 with the owner's key: rolling 4%, weekly 2%, monthly 1% at the time of the check, matching the card's shape.

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `01ef5dcb2cf3` (binary only) if the smoke fails. The v1 OpenCode CLI removal and the bot migration are machine/settings work, not part of this binary.
