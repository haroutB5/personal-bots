# Tool approval card (1.67.50)

Claude Code still asks for some Bash calls under full access (its bypass-immune safety checks). The chat shows each pending request as a card: "<bot> needs approval", the tool ("Run a command"), the command (long ones collapse behind "Show all"), the CLI's reason when it gives one, and Deny / Approve. The bot's Chats row reads "Needs approval" and opens the chat that holds the request. The card and the row clear when the request resolves in any way. The server declines a request nobody answers within 2 minutes (`T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS`, kill switch `T3CODE_PERSONAL_APPROVAL_TIMEOUT=off`) and tells the bot to retry with a simpler command.

## Sub-features

- `card` the command and the reason show on the card.
- `row` the Chats row reads Needs approval, and tapping it opens the chat at the card.
- `approve` Approve runs the tool: the fake bot answers `Approved: the command ran.`
- `deny` Deny declines it: the fake bot answers `Denied: User declined tool execution.`
- `timeout` an unanswered card is declined by the server: the fake bot answers `Denied: No one answered this approval within 2 minutes. ...`, the card goes, the row clears.

## Driving it with adb and uiautomator

Flow 10 sends `SAFETYQ` to `Assistant` three times (approve, deny, timeout). The fake CLI sends a `can_use_tool` request for Bash with a `$AD snapshot -i` loop command and the CLI's "can't be sure it read this command" reason. Screenshots `f10-*.png`. The timeout case waits up to 200 s.
