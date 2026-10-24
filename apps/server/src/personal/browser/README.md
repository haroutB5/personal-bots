# Shared browser runtime

The shared browser that bots and the owner use is Brave only (owner rule,
23 Oct 2026). Chrome is never a fallback.

## Launch interface

- No configuration: the installed Brave is discovered at launch, in this order:
  1. `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe`
  2. `%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe`
  3. `%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe`
- Override with `T3CODE_PERSONAL_BROWSER_EXECUTABLE=<absolute path>`. The path
  must exist and its image must be Brave (`brave.exe`); a Chrome path is
  refused.
- If no Brave executable exists, the launch fails with
  `BrowserExecutableUnavailable`, naming every path checked. The server keeps
  running; the browser status shows the launch error instead of starting a
  different browser.
- `T3CODE_PERSONAL_BROWSER_HEADLESS=1` still runs the same Brave build headless.

The existing profile, ad blocking, CDP screencast, priority raising, login
fill and egress guards are unchanged. `browserPriority.ts` treats the default
`brave.exe` image as the shared browser tree.

## Tests

- `browserExecutable.test.ts`: discovery order, explicit override, refusal of a
  Chrome path, and the clear missing-Brave failure.
- `driver.test.ts`: the launch receives `executablePath` and no `channel`.
- `PersonalBrowser.brave.test.ts`: the real-browser CDP/action suite, skipped
  when Brave is absent or `PB_SKIP_REAL_BRAVE=1` is set.
- `scripts/personal/e2e/browser.mjs`: the same rule for the phone e2e scripts,
  `E2E_BROWSER_EXECUTABLE` as the override.
