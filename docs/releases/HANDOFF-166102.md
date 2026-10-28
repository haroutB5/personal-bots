# 1.66.102 — chat images from the app's own artifacts folder, flaky interrupt test, permanent runtime checkout

**No migration, no schema change** (latest remains 114). Built on live 1.66.101
(`58a4c899b3df`) from its notes commit `1826ee592d`.

## "Image unavailable" for a bot-drawn image (`fix(server)`, `fix(web)`)

Harout saw a generated phone-size comparison render as "Image unavailable" in the Assistant chat.
The PNG existed the whole time at
`/home/harout/.personal-bots/dev/userdata/browser-artifacts/phone_size_compare.png`.

The cause is the host-file deny list, not a deleted file:

- `isProtectedHostPath` treated **everything** under a Bots `userdata` folder as private except
  `userdata/attachments` (`isProtectedBotsData` in `apps/server/src/workspace/HostFilePaths.ts`).
  `browser-artifacts` sits under that same `userdata` folder.
- The shared browser's own `preview_snapshot` tool writes screenshots there and tells the bot to
  embed the returned path: "Embed the path in your reply as `![alt](screenshotPath): this is the
only way to show the user a screenshot" (`apps/server/src/mcp/toolkits/preview/tools.ts`).
- In the transcript the Assistant had just received a `screenshotPath` under `browser-artifacts`,
  so it copied its generated PNG next to it (`cp /tmp/phone_size_out/phone_size_compare.png
.../userdata/browser-artifacts/phone_size_compare.png`) and embedded that path. The asset request
  was refused with `AssetProtectedFileError`, so the client painted the failure frame.
- Consequence: every saved preview screenshot, and any generated image a bot put beside one, could
  never render in chat.

Changes:

- `isProtectedBotsData` now allows the two media folders, `attachments` and `browser-artifacts`, and
  keeps every other entry under `userdata` private (database, sealed secrets, settings). The check
  still looks through `..` and symlinks (requested path and real path).
- The runtime instructions are unchanged: the context budget only ratchets down, and this release
  raises no prompt or tool text. The deny-list fix alone makes the path the preview tool hands to
  bots displayable.
- The chat failure now explains itself instead of only saying "Image unavailable"
  (`apps/web/src/components/ChatMarkdown.tsx`, `packages/client-runtime/src/state/assets.ts`):
  a missing file shows `File not found at <path>`, and a policy refusal shows
  `Not shown by the file safety rules: <path>`.
- Tests: `HostFilePaths.test.ts` allows a `browser-artifacts` image and still refuses the rest of
  `userdata`; `AssetAccess.test.ts` signs media in `attachments` and `browser-artifacts` and refuses
  `userdata/secrets`; `ChatMarkdown.workspace-images.test.tsx` renders a generated image from
  `browser-artifacts`, and checks the missing-path and policy-refusal messages;
  `assets.test.ts` maps the server errors to those reasons.

## The interrupt-failure test waits for the row it asserts (`test(server)`)

`ProviderCommandReactor.test.ts` ("stops a running session and records the failure when provider
interrupt fails") waited for `session.status === "stopped"` and then asserted the
`provider.turn.interrupt.failed` activity. The status and the activity are written by separate
steps of the same reaction, so the test could read the model between them and fail.

It now waits until the thread is stopped **and** the exact activity exists, then reads the model
once for the assertions. Proven with 30 consecutive runs of that test: 30 passed, 0 failed.

## Permanent runtime checkout (`chore(ops)`)

`hbots.service` ran from the builder worktree `/home/harout/Claude/AI/_wt/hbots-linux-ops`, which a
worktree cleanup could delete. Per Astra's `omarchy-system-tools-audit-2026-10-26.md` plan, the
release prepares a dedicated normal checkout at `/home/harout/Claude/AI/hbots-runtime`:

- A normal clone with its own Git objects (no `alternates`, so it does not depend on a disposable
  worktree), pinned to this release's notes commit.
- `node /home/harout/Claude/AI/hbots-runtime/scripts/personal/node/hbots.mjs status --root dev`
  runs from it (the CLI only imports Node built-ins and its own `lib/` files, so no
  `node_modules` are needed to serve).
- The checkout carries the gitignored public `.env`, copied from the current live worktree (same
  sha256, values never printed), because `serve` passes those values to the server process. Without
  it the relay and Clerk public config would be empty.
- The drop-in template is committed at
  `scripts/personal/linux/systemd/hbots-runtime-path.conf`. It changes `WorkingDirectory`,
  `ExecStart`, `ConditionPathExists` and `Documentation` to the runtime checkout, and deliberately
  leaves `EnvironmentFile` and `PATH` alone, so `~/.config/hbots/env` and the existing
  `10-opencode-path.conf` PATH still apply.

Verified before staging: the checkout is at the notes commit with no
`.git/objects/info/alternates`, `hbots.mjs status --root dev` runs from it (it reported the live
1.66.101 release), and an offline merged-unit check of the main unit plus both drop-ins resolves
`WorkingDirectory`, `ExecStart`, `ConditionPathExists` and `Documentation` to the runtime checkout
while keeping `EnvironmentFile` and the `10-opencode-path.conf` PATH.

Nothing was installed or restarted by this release: `~/.config/systemd` is untouched.

### Ship-time steps (DevOps, through the idle runner)

1. Verify the runtime checkout is still at this notes commit and has no alternates:
   `git -C /home/harout/Claude/AI/hbots-runtime rev-parse HEAD` and
   `test ! -f /home/harout/Claude/AI/hbots-runtime/.git/objects/info/alternates`.
2. Install the drop-in (this does not restart anything):
   `install -d ~/.config/systemd/user/hbots.service.d`
   `install -m 0644 /home/harout/Claude/AI/hbots-runtime/scripts/personal/linux/systemd/hbots-runtime-path.conf ~/.config/systemd/user/hbots.service.d/20-runtime-path.conf`
3. Reload and check the merged unit:
   `systemctl --user daemon-reload`
   `systemctl --user show hbots.service -p WorkingDirectory -p ExecStart -p ConditionPathExists`
   Expect the runtime path in all three. `systemctl --user cat hbots.service` must still show
   `EnvironmentFile=-%h/.config/hbots/env` and the PATH from `10-opencode-path.conf`.
4. Arm the 1.66.102 idle runner with the usual parameters and
   `--migration-before 114 --migration-after 114` (no backup). The runner restarts through
   `systemctl --user restart hbots.service`, which now starts the runtime checkout.
5. After `live_verified`, confirm the move:
   `systemctl --user show hbots.service -p WorkingDirectory` shows the runtime checkout, and
   `readlink /proc/$(ss -ltnp 'sport = :38472' | grep -o 'pid=[0-9]*' | cut -d= -f2)/cwd` shows it
   too; `/version.txt` still shows 1.66.102 and the release sha.
6. Keep `/home/harout/Claude/AI/_wt/hbots-linux-ops` in place. This release does not clean it up.

### Rollback (unit path only)

If the runtime path fails after the restart, restore the old unit without deleting anything:

1. `mv ~/.config/systemd/user/hbots.service.d/20-runtime-path.conf ~/.config/systemd/user/hbots.service.d/20-runtime-path.conf.disabled`
2. `systemctl --user daemon-reload`
3. `node /home/harout/Claude/AI/hbots-runtime/scripts/personal/node/hbots.mjs restart --release <previous release sha12>`
   The old checkout still exists, so the main unit's `WorkingDirectory` and `ExecStart` work as
   before.

If the drop-in was installed but the release was refused before its restart, the server never
moved; steps 1-2 alone put the unit back.

## Desktop control drives the user's own browsers, with the Bots app and sensitive captures closed (`fix(server)`)

Computer use on Linux refused every window whose class began with brave, chromium, chrome or
google-chrome, so a bot could not click in Harout's own Brave (YouTube Music, signed in) or a
throwaway-profile Chromium, and the shared-browser tools cannot sign in to Google. It now drives
the user's own Brave, Chromium, Firefox, Edge and Vivaldi windows and still refuses four things:
the bots' shared browser, the Bots app itself, any window showing a site Harout marked sensitive,
and password managers. `apps/server/src/personal/desktop/linux/browserWindows.ts` decides per
window; the focus guard, the point guard and every key chord ask it.

- **Shared browser.** Identified by the window's process, not its class: its `--user-data-dir`
  sits under `<baseDir>/personal/browser-profiles`. `/proc/<pid>/cmdline` is read through a cache
  keyed by pid **and** `/proc/<pid>/stat` field 22 (the start time), so a reused pid cannot inherit
  the previous browser's profile. Both sides are real paths and the folder match needs a path
  boundary. Brave rewrites its process title, which collapses the argv to spaces on this build, so
  the parser accepts NUL-separated args first and a collapsed line second; a profile path with a
  space stays one argument when the NULs survive. The live check below caught the collapsed form.
- **The Bots app, any window class.** A window whose title is the app's own is refused with
  `This window is the Bots app; bots can't drive it from the desktop.` The check runs before the
  browser-class test, so Firefox, Edge, Vivaldi and an Electron window are covered too. The app name
  and manifest name live in `packages/contracts/src/personalAppIdentity.ts`;
  `apps/web/src/branding.ts` and the web manifest read the same values, and a web test fails if
  branding or the manifest drifts. Titles match by containment on `T3 Code` (so a browser's
  ` - Brave` suffix or a future chat prefix still matches) and exactly on the manifest name `Bots`
  (which a PWA can show while loading). The installed Bots PWA's window class is read from its
  `.desktop` shortcut (`StartupWMClass`, or `--app-id` in `Exec`) under `$XDG_DATA_HOME/applications`
  and `~/.local/share/applications`, cached for a minute; no Bots PWA is installed today, so the list
  is empty, and installing one adds its class without a code change. If a shortcut cannot be read,
  an untitled `<browser>-<id>-Default` PWA window is refused (it could be the app loading); another
  PWA with its own title still passes.
- **Sensitive sites.** A title that names a saved login with the sensitive flag stays blocked, on
  the host and the label, case-insensitively, now on word boundaries (`barclays` no longer matches
  `barclaysian`). If the list cannot be read, browser windows stay blocked as before. The guard
  reads only `origin` and `label` (`PersonalLoginRepository.sensitiveSites`), never the full login
  rows with their sealed passwords.
- **Password managers.** Refused by class (1Password, Bitwarden, KeePassXC, Enpass, Proton Pass)
  and by browser title (`passwords`, `password manager`, `1password`, `bitwarden`, `keepass`,
  `proton pass`, `enpass`, `chrome://password-manager`, `brave://password-manager`,
  `edge://settings/passwords`), which covers their PWAs too. The refusal says which rule fired.

### Keys and sensitive captures

- **Every chord is re-guarded.** `computer_key` used to check the focused window once per call;
  two chords could cross into a sensitive or Bots-app window. Each chord now clears the window
  cache and runs the focus guard again, and a call is capped at 60 presses across `repeat ×
combinations`. A hold cannot re-guard mid-press, so `computer_hold_key` refuses chords that
  switch window or browser tab (`ctrl+tab`, `ctrl+1`-`ctrl+9`, `ctrl+PageUp/PageDown`, `alt+tab`,
  `super+*`) and tells the bot to use `computer_key`.
- **Screenshots carry a taint.** Every bot capture (`computer_screenshot`, `computer_zoom`, and the
  after-action screenshot) lists the mapped windows that overlap the capture rectangle (one
  `hyprctl clients` read, the same list the point guard uses, no extra process) and records each
  sensitive origin a browser window in it names. It reuses the shared browser's store
  (`personal_sensitive_exposures`, migration 077) for the thread **and** its root task, so it
  survives a restart exactly as the browser's does, and a failed list read is treated as carrying.
- **While carrying, input pauses.** `computer_type`, `computer_key`, `computer_hold_key`,
  `computer_click`, `computer_drag` and `computer_mouse_down` are refused with the shared browser's
  `Paused:` wording: the bot calls `request_browser_help`, the Computer tab shows the same
  `ComputerSensitiveCard` with Allow once / Refuse, and one approval covers one action. Screenshots
  and the pointer stay available, so the bot can still look. `request_browser_help` accepts a
  desktop pause even when the thread never took the browser lease.

**What this is.** A mistake-prevention rail, not a security boundary. It only knows the sites
Harout marked sensitive in Bots, plus password managers and the shared browser. A site he did not
mark, another browser profile signed into something else, a bot's own shell, a provider's web tools
or another machine get no pause. The tool text now also says: in the user's own browser, never sign
in, use saved passwords or autofill; ask the user.

Tests: `browserWindows.test.ts` covers the shared pid, a reused pid, NUL and title-collapsed
command lines, a space in the profile path and the boundary check, the user's Brave and temp
Chromium, a Brave PWA, Firefox/Edge/Vivaldi classes, every Bots title variant and the installed PWA
class, another app's PWA and the untitled fallback, sensitive labels on word boundaries, password
manager titles, an unreadable list and an unidentifiable process. `driver.test.ts` covers both
guards, a Bots window in a Firefox class, a password-manager title, two chords crossing into the
Bots app (the second never reaches the helper), the hold-switch refusals, the 60-press cap and the
sensitive sources a capture reports. `PersonalDesktop.activity.test.ts` proves a capture records
and a pause blocks typing, clicking, keys and holds without reaching the driver;
`PersonalBrowser.test.ts` proves the desktop taint is persisted, opens the card without the browser
lease, and passes one action after Allow once then asks again. The web branding test pins the app
identity to the manifest and the contract.

## Gate

All six gates and gate evidence run from the final staged sha in this worktree with its own
`node_modules`; the record is in the Gate evidence section below. Server, web, client-runtime and
end-to-end results are recorded there with their exit codes.

## Gate evidence

<!-- gate-evidence:begin sha=34e3ea1c326204bc53e856ef389181d1d0b448c9 release=34e3ea1c3262 json-sha256=39a1c82b1297062a6fbcd37b1168738a6783d5b3a89c52e1da86012dea7349d4 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- client-runtime-tests: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
