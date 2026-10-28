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

## Gate

All six gates and gate evidence ran from `cc04dcff706d` in this worktree with its own
`node_modules`; the record is in the Gate evidence section below. Server tests: 3506 passed,
6 skipped. Web tests: 3176 passed. Client runtime: 22 passed. e2e: 12 of 12 journeys passed.

## Gate evidence

<!-- gate-evidence:begin sha=cc04dcff706de41088c0cfa416a2bd7dbcfb71c1 release=cc04dcff706d json-sha256=5a97e85a75dfbb8a097d76ae47816c2ae6a3cd10811ba528c5c334b87a6c4063 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- client-runtime-tests: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
