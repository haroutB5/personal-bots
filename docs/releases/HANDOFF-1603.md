# 1.60.3: Desktop remote offers the phone keyboard when the PC's focus is in a text field

Harout's report (14:42): in Computer > Desktop with Control on, tapping Edge's address bar focused it
on the PC but no keyboard came up on the iPhone. iOS only raises the keyboard for a focus inside the
user's own tap, so a focus answer from the PC can't raise it by itself.

## What changed

- Helper (`helperSource.ts`): new `focus` command, answered on its own thread (never behind queued
  input; only the newest ask is looked into). UI Automation's focused element decides: Edit (unless
  read-only), Document/ComboBox/Group/Custom/Pane with a writable value, or a Group with a text
  pattern and no value (a web contenteditable). The foreground thread's system caret is the fallback
  when UI Automation can't answer. Reports `editable`, `password`, the field rect (physical px),
  control type and class. Never reads the value. Compiled against WPF's UIAutomationClient,
  UIAutomationTypes and WindowsBase (`DesktopHelper.ts`). 1-15 ms warm, ~100 ms first call.
- Server (`routes.ts`, `PersonalDesktop.ts`, `desktopRemote.ts`): after a click, a button release,
  any key, or Enter in text, the socket looks 60 ms later (and again at 300 ms before saying "no
  field"), and sends `FocusChanged {editable, password?, rect?}` (rect as monitor fractions, clipped
  to the monitor). It also looks when control starts. A newer input drops an older look's answer.
- Contracts: additive `PersonalDesktopViewMessage` `FocusChanged`. An older app ignores it.
- Web (`DesktopPane.tsx`): a "Tap to type" button above the key bar while the PC's focus is in a
  text field and the keyboard is down; its tap raises the keyboard. A tap on the field the PC
  already reported focused raises the keyboard inside the tap (fast path); taps elsewhere never do,
  so no flicker. The keyboard stays up across taps on the picture; it goes down only with the
  keyboard button, the done key, or leaving control. Keys, IME/dictation and paste unchanged.

## Detection (probe of the compiled helper, my own test windows)

| Target                                                   | Focused element                               | editable |
| -------------------------------------------------------- | --------------------------------------------- | -------- |
| Edge address bar                                         | Edit, OmniboxViewViews                        | true     |
| Chrome address bar                                       | Edit, OmniboxViewViews                        | true     |
| Page input / password / textarea (Edge, Chrome)          | Edit (password flagged)                       | true     |
| Page contenteditable (Edge, Chrome)                      | Group with text pattern                       | true     |
| Bing search box                                          | Edit, b_searchbox                             | true     |
| Notepad text area                                        | Document, RichEditD2DPT (caret too)           | true     |
| Windows search box (Win+S)                               | Edit, RichEditBox                             | true     |
| Page body, button, browser chrome, Notepad menus/buttons | Document read-only / Button / Pane / MenuItem | false    |

Evidence: `~/.personal-bots/qa/backend-caret/detection-evidence.log`.

## Phone check (WebKit, touch, 390x844, throwaway on release 82a07212aa58, port 38691)

`~/.personal-bots/qa/backend-caret/phone.mjs`, `phone-report.txt`, `shots/`. Tap field A: pill shown.
Pill tap: proxy field focused. Typed "hello caret": arrived in field A on the PC. Tap field B with
the keyboard up: proxy stays focused, "second field" arrived in B. Done key: pill back. Tap B again
(reported field): proxy focused in the tap (fast path). Tap the plain area: no keyboard, pill gone.
Control off: pill gone. Server log 0 ERROR. Not verified on a real iPhone.

## After it goes live

On the iPhone: Computer > Desktop, Control on, tap Edge's address bar: "Tap to type" appears; tap
it, type, tap another field: the keyboard stays up.
