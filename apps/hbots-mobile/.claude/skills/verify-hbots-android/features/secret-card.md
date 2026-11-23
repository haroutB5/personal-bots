# Secret request card (1.67.53)

A bot asks for an API key with `request_secret`. The chat shows a card: "<bot> needs a secret", the label, the purpose, the key name, a password field, "Allowed address" and Decline / Save secret. From 1.67.53 the card shows one problem line in a footer just above the buttons (`accessibilityRole="alert"`): the address check after a Save attempt, or the server's error when a save or decline fails. Typing in the card clears a server error. Before 1.67.53 the address problem sat inside the card's scroll area and could be out of view, and a failed save or decline showed nothing.

## Sub-features

- `problem` Save with a value but no address shows "Enter the address this key may be sent to, ..." on screen, above the buttons.
- `clear` typing a valid address clears it.
- `save` Save settles the card: "You saved <label>. ..."
- `server-error` a failed save or decline shows the server's message in the footer (unit tests only: `SecretRequestCard.test.ts`; the throwaway server does not fail on demand).

## Driving it with adb and uiautomator

Flow 12 sends `MCPONCE request_secret {...}` (MCPONCE: with the schedulers on, the task resumes after the save and must not ask again) (name `QA_FLOW12_KEY`, no origins) to `Developer`, scrolls the card to its top, types a value in the field above "Allowed address", taps Save secret, checks the problem text is drawn and sits just above Save, types `https://api.example.com` in the last card field, and saves. The pending card sets FLAG_SECURE, so its screenshots are black; the checks read the UI dump (`f12-problem-dump.txt`). Only `f12-saved.png` (settled card) shows content.
