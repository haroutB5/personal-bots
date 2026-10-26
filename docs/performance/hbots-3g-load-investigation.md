# hbots slow-connection investigation (in progress)

Base: `feat/hbots-16697` at `872cbed458a5b075f666ddddc144904fbe4fc487`. Upstream main was fetched at `dd5b5401e1f240f4314af29edf431369d182f386`. No hbots performance changes have been made or measured in this investigation.

## Upstream changes

These commits are in upstream main after `8f02648`, but are not ancestors of the hbots base. They depend substantially on upstream orchestration v2, which the fork intentionally does not merge. They are candidates for adaptation, not ports completed here.

| Commit | Change | Consideration for hbots |
| --- | --- | --- |
| `553203c57b` | Bounds rows and encoded bytes within long turns. | The fork already windows by user turn and raw turn count; a single large turn can still need investigation. Preserve recent messages and older-history access. |
| `e19fe0837b` | Sends duplicate message and related bodies once, reconstructing them at the client. | Requires compatible wire contract and fallback for old clients. |
| `80455376f0` | Deduplicates long identifiers in thread snapshots. | Requires compatible encoding and decoding at both ends. |
| `67c3afbd58` | Omits idle subagent threads from the initial shell. | Bots, group and task views may need these rows; audit all consumers first. |
| `e57c093cdd` | Omits older settled threads from the initial shell and loads them separately. | Requires a complete retrieval path for existing chats, search, tabs, and sorting. |
| `abd9d9f970` | Loads provider workspace snapshots on demand instead of broadcasting all of them in configuration. | The fork already supports a lightweight provider catalog on personal paths; measure remaining traffic before adapting. |
| `17dc1afa15` | Avoids unchanged shell and configuration cache writes. | Assess separately for write and CPU cost; it does not establish a network speedup. |
| `c7e3993fe9` | Speeds up shell snapshot reads on large databases. | V2-specific query changes need comparison with the fork's projection SQL. |
| `d7a8d6f320` | Avoids a full shell read when resuming. | Requires the fork's replay and completeness safeguards. |
| `fd1063ba7c` | Keeps subagent transcript updates off the shell stream. | Audit the fork's bot, task and team consumers before adapting. |

Upstream development branch `upstream/t3/resume-shell-from-persisted-cache` contains `4d0467362b` (guarded cached-shell resume) and `124f10be57` (limits replay size). Neither is an ancestor of fetched upstream main. The former validates server and client identity, selection and cache age, and has replay and reset logic; it must not be replaced with an unguarded cached cursor.

The fork already has HTTP compression, WebSocket per-message compression, ten-user-turn initial thread pagination and the personal-path provider catalog reduction. Its shell code refreshes the authoritative HTTP snapshot for a new session, while same-session resubscriptions can resume. See `apps/server/src/http.ts`, `apps/server/src/server.ts`, `packages/client-runtime/src/state/threads.ts`, `packages/client-runtime/src/state/shell.ts`, and `apps/web/src/features/personal/providerCatalogScope.ts`.

## Measurement status

The supplied backup was copied into an isolated throwaway server with schedulers disabled and fake providers. Its release binary differs from the requested base only in release documentation. The live database was not opened or copied. Three active bot chats were selected by total UTF-8 message-body bytes (not by full snapshot size). On direct, unthrottled HTTP requests, the shell was 2,355,426 decoded JSON bytes and 254,456 compressed body bytes, with 1,585 thread entries. With `turnLimit=10`, the three chat snapshots were 100,524 / 12,050, 140,365 / 35,379, and 587,737 / 145,200 decoded / compressed body bytes respectively. These are single endpoint diagnostics, not 3G timings, total journey wire sizes, or proof of which chat has the largest serialized snapshot.

An additional direct HTTP diagnostic used three fresh gzip requests per endpoint, a fixed 400 ms pre-request delay and application-level 50,000 B/s pacing of response bodies. The median endpoint times were 6,024 ms for the shell and 681, 1,171 and 3,443 ms for the three chat snapshots. Compressed response bodies were 272,963, 13,185, 37,293 and 148,987 bytes respectively. The browser's earlier compressed sizes differ because it negotiates a different encoding. This diagnostic does not emulate TCP handshake/RTT or uploads, and excludes WebSocket traffic, assets, rendering and the relay. It is not a 3G journey benchmark and cannot be compared with Theo's figures.

No 3G journey baseline, after measurement, relay measurement, new budget, feature change, or gate result exists yet. Do not use Theo's upstream numbers as hbots measurements.

Next: measure cold connect, reconnect, and three large chats for three runs at 400 kbps up/down and 400 ms RTT with new TCP connections, including wire and decoded JSON bytes. Establish a safe isolated relay route before reporting relay measurements. Then measure each proposed change with a kill switch, preserve the existing chat behaviors, ratchet only proven wins, run the fork gates and real checks, and hand the pushed branch to CTO for QA and release.
