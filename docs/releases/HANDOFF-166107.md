# 1.66.107: Android UI fixes from QA's audit

Based on 1.66.106 via personal-bots/main (be6ce43549). No migration; schema remains 114. Fixes the hbots UI for the Oppo Find X9 Pro (installed Chrome PWA, dark, 360x785 CSS px, DPR 3) from QA's audit `/home/harout/Claude/AI/dev-team/qa/hbots-android-audit/REPORT.md`. Branch `fix/hbots-16707`. Web only; the server is unchanged.

**If the white bar persists under the page, remove the app and reinstall it.** The bar is the WebAPK window behind the page, coloured by the manifest. The manifest is now `#0a0a0a` for `background_color` and `theme_color`, but Android refreshes an installed WebAPK's manifest lazily and may keep the old colours until the app is reinstalled. A tab in Chrome picks the change up at once.

## What changed

| Item | Change |
| --- | --- |
| P1 white gesture strip | Manifest colours dark. `syncBrowserChromeTheme` uses the theme token (or the inset surface) and never reads back its own inline body colour, so the theme-color meta cannot go stale. |
| A2 scrollbar | The custom scrollbar rules apply only on `(hover: hover) and (pointer: fine)`: no classic scrollbar on touch, desktop keeps it. |
| A3 status line | Disk label dropped when unknown, wider separators, bigger tap area for the link. |
| A4 pinned strip | One 11px caption, simpler model label, tighter gaps at 380px and below. |
| A5 bot row | Model and marker share one truncating span. |
| B1 Back | Android Back closes the open sheet, menu or dialog first (new `lib/overlayBack.ts`, wired into the dialog, sheet, alert-dialog, menu and popover wrappers). Touch devices that are not iOS only. |
| B5 chat subtitle | Subtitle fits at 360px; header gap tightened. |
| Notifications | Android Chrome no longer tells you to add to the home screen to get push; test-notification button; checkbox accent colour. |
| Attachment-only bubble | An attachment with no text no longer shows an empty bubble or the internal placeholder. |
| Question card | Enter commits only where it should. |
| Push icon | Service worker fallback icon is `/icons/bots-192.png`. `SW_REVISION` is unchanged on purpose (the release runner pins it). |
| B9 Tasks tabs | "Scheduled" no longer truncates at 360px. |
| B10 Computer header | Subtitle ("Nobody is using it") is no longer squeezed by the CPU/RAM pill at 360px. |
| B16 autofill | `autocomplete="off"` on the New group name field; the other name fields already had it. |

## Not done, on purpose

- B6, B7, B15, B17, B18: left as they are (low value or not a defect on the device).
- B13 maskable icon: needs new artwork.
- Select and Command overlays are not wrapped in the Back handler yet; Back leaves the screen with one of those open, as before.
- No push badge on the app icon.
- The bot-list preview of an attachment-only message may still show the placeholder text; only the bubble was fixed.

## Where to look (QA focus)

- B1 history behaviour, on a real Android device: Back with a sheet or menu open closes it and stays on the page; Back from a chat still goes to /bots; Back from a page opened out of Team returns to Team; opening a chat from a sheet row and then pressing Back lands where it did before. The logic is unit-tested against a fake browser history (`overlayBack.test.ts`); it has only had a real-browser check at emulator level.
- Gesture strip dark in a tab and, after reinstall, in the installed app.
- Scrollbar: none on the phone, still there on a desktop browser.

## Gate evidence

<!-- gate-evidence:begin sha=55f0579dbdb9a588acd071da78976e59f8159224 release=55f0579dbdb9 json-sha256=b2c24144b2c8d154a4fb66f1c7be46182fba47d026c8376f93f4b635418d5804 result=PASS -->
- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
<!-- gate-evidence:end -->
