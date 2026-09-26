You resolve an upstream T3 Code merge in the Bots fork's sync worktree (`C:\Claude\AI\personal-bots-sync`, branch `sync/upstream-<date>`). The script above this text lists the task (conflicts, a red gate, or a decision to hold with `keep_ours`), the triage verdict and the gate commands. Read AGENTS.md first.

Rules:

- Never commit, push, switch branches, reset, stash, rebase or run PowerShell. The script commits.
- Your working directory is already the sync worktree: never `cd`. Run one command per Bash call; a `cd` combined with a pipe is refused. Pipe only through head, tail, grep or wc.
- `apps/server/src/persistence/Migrations.ts`, `upstreamMigrationIds.ts` and `apps/web/src/routeTree.gen.ts` are handled by the script. Don't touch them.
- Additive lists and unions (RPC groups in `packages/contracts/src/rpc.ts`, the `RpcAuthorization` map, subscription tag unions in `packages/client-runtime`) keep both sides, ours first. Check closing brackets, and that no line was dropped or duplicated.
- `apps/server/src/server.ts`: a `Layer.pipe` takes at most 20 steps. Keep our split `.pipe(...).pipe(...)` layout, never take upstream's copy of a block we split (that duplicates it), and port upstream's edits inside the block by name. Grep for every identifier upstream renamed, because typecheck misses a rename when the old name still exists.
- Personal code (`apps/server/src/personal/**`, `apps/web/src/features/personal/**`, `packages/contracts/src/personal*.ts`, the personal hooks in ProviderCommandReactor/ProviderService/adapters) wins on behaviour. If upstream changed an API it uses, adapt the personal code. If that needs a product decision, stop with `needs_judgment`.
- Keep the personal isolation intact: Claude `settingSources: []` + `strictMcpConfig` for bot sessions, the Codex bot launch args, OpenCode's bot `XDG_CONFIG_HOME` + `shell.env` plugin (opencodeBotIsolation.ts), and the personal-bot-thread title guard in ProviderCommandReactor.
- Holding a decision with `keep_ours`: make the smallest change that keeps our current behaviour (a pin, a guard, or our side of a hunk), add a test that fails if upstream's behaviour comes back, and name the decision id in a code comment.
- After resolving, `git add` the files, run every gate command listed below, and fix what you broke. Never delete or skip a test to go green. Report `resolved` only if every listed gate passed on your last run; list pre-existing failures (listed below) in `reasons`.
