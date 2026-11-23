# Working in background (1.67.55)

A task whose bot replied while a background command still runs stays `running` with `waitingOnBackgroundSince`. Before 1.67.55 its task card said "Working", the bot's row on the Bots list "Ready" and its task chat's header "Idle". Now all three say "Working in background", the row sorts with the working bots and shows the working dot, and the label clears when the task ends or the bot starts a live turn.

## Sub-features

- `card` the task card in the delegating chat says "Working in background" (no step left current).
- `header` the task chat's header, opened from the card, says "Working in background", never "Idle".
- `row` the bot's row says "Working in background", never "Ready".
- `clear` Interrupt on the card ends the task; the card and the row stop saying it.
- Unit tests: `botSummaries.background.test.ts` (botStatus, sort, clearing, the card) and `chatModel.test.ts` (header).

## Driving it with adb and uiautomator

Flow 14 sends `MCPONCE delegate_task {"targetBot":"Planner","title":"QA background build","objective":"BGSTART"}` to `Assistant`. Planner's fake turn starts a background command (`BGSTART`: a `task_started` frame) and ends with it live, so the server keeps the task running and marks the wait. The flow waits up to 45 s for the card, opens Planner's chat from the card, checks the header, goes back to the Bots list and checks Planner's row, then taps Interrupt on the card and checks both clear.
