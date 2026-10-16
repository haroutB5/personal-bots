# HANDOFF 1.66.57

## What changed

A DeepSeek bot on the `dsh` engine showed DeepSeek's own tool-call markup in a
visible chat reply (Security's review chat, 2026-10-15T23:32:59Z; recorded in
memory on 16 Oct as "strip DSML tags from dsh reply text"). 1.66.57 strips that
markup inside the dsh adapter, before a delta reaches the chat.

### The leaked sample (shape only, no arguments)

The one live row that holds it is `projection_thread_messages`, thread
`f32abe85-b574-4f78-af9c-e4c84536545f` ("Security review: hbots 1.66.54 voice
calls"), message `assistant:assistant:1381185e-…:segment:2`, 5133 characters. It
is a normal reply (ending in a ` ```choices ` block) followed by a blank line and
three stray **closing** tags, each alone on its line:

```
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

Read from the DB (read-only) at the codepoint level: `<` `U+002F` then
`U+FF5C` `U+FF5C` `D` `S` `M` `L` `U+FF5C` `U+FF5C`, a space, the tag name and
`>`. So the marker is `｜｜DSML｜｜` (two full-width bars, `DSML`, two more) and
the closing form has a space before the name. **No opening tag and no argument
leaked in that row**: the harness had consumed the invoke and its parameters and
left only the strays. The marker itself is unambiguous: no bot's own words
contain it. (14 rows match `%DSML%` today: this one, one assistant row that
merely _talks about_ "DSML tags" - it must stay untouched - and twelve reasoning
rows, which the chat hides by design and which are out of scope.)

### The change

| File                                                         | What                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/acp/DshAcpSupport.ts`              | `makeDshReplyStripper()`: the streaming stripper, with its tag reader and marker constants                                                        |
| `apps/server/src/provider/Layers/DeepSeekDshAdapter.ts`      | Every `ContentDelta` goes through the turn's stripper; a stripped `invoke` logs one WARN; the turn's held text is flushed before `turn.completed` |
| `apps/server/src/provider/acp/DshAcpSupport.test.ts`         | 7 new tests (the leaked sample, splits, blocks, fences, no-markup)                                                                                |
| `apps/server/src/provider/Layers/DeepSeekDshAdapter.test.ts` | 1 new test through the real ACP runtime                                                                                                           |
| `apps/server/scripts/acp-mock-agent.ts`                      | `dsml-probe` frames (env-free, prompt-triggered), test fixture only                                                                               |
| `scripts/personal/app-version.txt`                           | 1.66.57                                                                                                                                           |

Behaviour:

- **A whole block goes.** An opening tag starts a dropped region that ends with
  its matching closing tag, nesting by name (`tool_calls` > `invoke` >
  `parameter`), so a leaked `parameter`'s value never reaches the chat. An
  opening tag with no closing tag drops the rest of the turn (the safe way: the
  arguments are the part that can hold secrets).
- **Stray tags go, and take their line with them.** A closing tag that sat alone
  on its line takes that line's whitespace, so a cleaned reply does not end in
  blank lines (the sample renders as the reply plus one trailing newline).
- **A tag split across deltas is still a tag.** Only a possible tag prefix (at
  most 4096 characters) is held back, plus a whitespace-only tail; both are let
  through at the turn's end, so ordinary text is never held.
- **Nothing else changes.** Only a `<` that really starts the marker is touched,
  so code fences, `a < b`, `<reply_style>` and other angle brackets are byte for
  byte identical.
- **One WARN per stripped tool, never its arguments**:
  `Removed DeepSeek tool-call markup from a bot reply` with `{threadId, botId,
tool}`. A real call that the markup carried can no longer vanish silently. It
  is a WARN, so it never trips the runner's ERROR scan.

Server-only, inside the dsh adapter. No migration (latest stays 110, rollback is
binary only), no contract change, no web source change.
`PERSONAL_TASKS_CONCURRENCY = 5`, unchanged.

## Proof

### The stripper (unit, `vp test run src/provider/acp/DshAcpSupport.test.ts` - 19 passed, 12 before)

- **The exact leaked string from the row**, byte for byte (its own codepoints
  asserted), fed as one delta: the reply renders as its own text - the
  ` ```choices ` block intact - plus a single trailing newline, with no `DSML`
  anywhere, and it reports no tool (stray closing tags name none).
- **Split across 2 deltas**: every one of the 111 cut points of that sample
  gives the same output. **Split across 3 deltas**: every pair of cut points of
  a compact sample (1830 combinations) gives the same output.
- **A whole block**: text before and after it survives, the block is gone, the
  tool is reported, and the arguments (`tennis scores`, `C:/secrets/key.txt`)
  never appear in the output. An opening tag whose block never closed drops the
  rest of the turn and still names the tool.
- **Lookalikes stay**: a code fence holding `<||DSML|| parameter>`,
  `<| DSML | parameter>` and `<｜｜DSML parameter>`, `a < b and a > b`,
  `<bot_instructions>`, `<reply_style>`, and prose that mentions "DSML tags":
  all byte-identical, and no tool reported.
- **No markup at all**: byte-identical at chunk sizes 1, 2, 3, 5, 7, 13, 64 and
  as one chunk.
- A trailing `<` and `</` are shown (ordinary text); a marker cut short at the
  end of a turn is dropped.

### The adapter (real ACP runtime, real adapter, recorded frames - `vp test run src/provider/Layers/DeepSeekDshAdapter.test.ts` - 16 passed, 15 before)

`strips leaked tool-call markup from a reply, and warns about its tool`: the
mock agent's new `dsml-probe` branch streams the real frame order - an
`agent_message_chunk` with a normal reply, then an `invoke name="web_search"`
block **split across two frames** (one cut inside `<｜｜DSML｜｜ param`), then the
three stray tags. The adapter's visible deltas join to exactly `Before.After.`,
contain no `DSML` and no `tennis scores`, and exactly **one** WARN fires with
`{threadId, botId: "bot-one", tool: "web_search"}`.

Unchanged on the same path: `starts a new reasoning paragraph when a thought
follows a tool call` still asserts the visible reply is exactly `["Done."]`, so
a reply with no markup is untouched through the real runtime.

Full provider suite `vp test run src/provider` (in `apps/server`): 107 files
passed, 2 skipped; 1765 tests passed, 58 skipped. `tsc --noEmit` in `apps/server`
exits 0. Lint on the five changed files (the repo-wide lint command, limited to
those paths): 0 errors, 1 pre-existing warning (an unused `Queue` import in the
adapter test file). The fork gate's `server-tests` runs `src/personal src/mcp`,
so it does not include these provider tests: they were run separately, as above.

### No live DeepSeek turn

The leak is stochastic - it needs DeepSeek to emit its markup and dsh to leave
part of it in the text stream - so a throwaway turn cannot reproduce it on
demand, and a real turn would cost quota for no extra coverage. The recorded
frames through the real ACP runtime are the deterministic proof and drive the
real adapter code path end to end. (Build: `build.ps1 -CopyExternals`, staged,
not activated; all four public T3 Connect values are present in the release's
`dist`, checked by value match -> boolean, values never printed.)

## Gate evidence

<!-- gate-evidence:begin sha=1a69d1adb2d333a32c190789641452a334fe0573 release=1a69d1adb2d3 json-sha256=85fb67620ad724027da5b413ef25c6d42d5bcd46b8fe4ad7a155530dbb11ec2b result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-16T11:22:38Z. Version 1.66.57, release `1a69d1adb2d3`, commit `1a69d1adb2d333a32c190789641452a334fe0573` on `release/hbots-16657`, working tree clean, result **PASS**.

Machine-readable copy: `releases\1a69d1adb2d3\gate-evidence.json` (sha256 `85fb67620ad724027da5b413ef25c6d42d5bcd46b8fe4ad7a155530dbb11ec2b`) and the full gate logs in `releases\1a69d1adb2d3\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2813 tests passed, 0 failed, 4 skipped, in 202 files | 214.4   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 18.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2810 tests passed, 0 failed, 0 skipped, in 251 files | 31.2    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 15.7    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 253 checks ok, 0 failed                              | 64.8    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16657\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\1a69d1adb2d3" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 256.6   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `1a69d1adb2d333a32c190789641452a334fe0573`, at end `1a69d1adb2d333a32c190789641452a334fe0573`; tracked files modified: none. Staged release: version 1.66.57, sha 1a69d1adb2d3, dirty False, externals copied; `dist/bin.mjs` sha256 `07ba0d94cb0f29d9245f99adda2598b002d92ea14f9101a6f3f6fbc2f47d395a`.
<!-- gate-evidence:end -->

## For QA / CTO

Small, contained, server-only change inside the dsh adapter: the builder's proof
above is the tier (5 Oct rule). No data, no migration, no release tooling, no web
source. If a second pair of eyes is wanted, the useful check is a throwaway root
with a DeepSeek bot on `dsh`: after a turn that used a tool, the chat must show
no `｜｜DSML｜｜` text, an ordinary reply must read exactly as before, and a
stripped call must appear in the server log only as
`Removed DeepSeek tool-call markup from a bot reply` with a `tool` field and no
arguments (never as ERROR).

## Cleanup

- Staged only: release `1a69d1adb2d3`, `current.txt` still `59d9ae565f70`
  (1.66.56), so the rollback baseline is `59d9ae565f70`.
- Nothing is left running: no throwaway server, no browser session, no background
  job. Worktree `_wt/hbots-16657`, branch `release/hbots-16657`; its
  `node_modules` is a real install (made with another worktree's `vp` shim), not
  a junction, so the worktree is self-contained when it is removed later.
- `/｜｜DSML｜｜/` remains in the one historical DB row (and in reasoning rows);
  nothing was written to the live database.
