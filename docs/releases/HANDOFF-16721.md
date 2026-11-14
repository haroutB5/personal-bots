# 1.67.21: server kept out of swap, stall causes, tasks resume after a usage limit

Based on 1.67.20 (`a72547da6f6c`, trunk `4b555cad22`). Branch `release/16721`, built from `rc/1.67.21` at `b62c61b532`. No schema change (stays 157). `PERSONAL_TASKS_CONCURRENCY` stays 5. `minimumNativeVersion` is unchanged. A new Android APK ships with this release (version bump only in the mobile package), built with Firebase on.

## Why

Heavy jobs that filled memory pushed hbots.service into swap, and the server froze for seconds at a time. The stall watchdog recorded each freeze but not its cause. A task stopped by a provider usage limit failed and had to be restarted by hand.

## What changed

- **Server kept out of swap.** New systemd drop-in `scripts/personal/linux/systemd/hbots-no-swap.conf` (`MemorySwapMax=0`), installed by `install-units.sh` (`d80b2235cb`, `daf1fc8002`, `41dbd20672`). Already placed on this laptop by the lead on 14 Nov at 02:05 GMT. The release runner does not write unit files.
- **Stall causes.** The stall watchdog records fault, swap and pressure deltas per stall and a `cause` label (swap-in, disk, CPU or reclaim), taken only from main-thread evidence (`682ce52b3d`, `0c03a22f64`, `95173b410d`).
- **Tasks resume after a usage limit.** A task stopped by a provider usage limit waits for the reset and runs again by itself (`27203fb118`, `7851cb7672`). One new optional field in `packages/contracts/src/personalV1Wire.ts`, so 1.67.20 phones keep working against this server.
- **speedoptimiser skill.** Text update only (`6b649a56e4`).
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.21. No code changes in the bump commit.

## Migration

None. Schema stays 157. The runner skips the backup (no migration).

## Verification

- Memory stalls (Verifier 2, measured): `dev-team/qa/hbots-memory-stalls/VERIFY.md`, section "Recheck 41dbd20672", PASS, no blockers.
- Limit resume (Verifier, measured): `dev-team/qa/hbots-limit-resume/VERIFY.md`, PASS at `7851cb7672`, no blockers, including a throwaway-server run and typecheck of contracts, personal-client, web, hbots-mobile and server.
- The merge `b62c61b532` of the two reviewed branches was clean. Full gates run on the release commit below.

## Rollback

Binary only. The previous release is `a72547da6f6c` (1.67.20). No schema change, so 1.67.20 boots on the same database. The previous APK (1.67.20) stays in `android-updates/`. The no-swap drop-in is a unit file and stays in place on rollback.

## Known and accepted

- The new stall test for case 3a asserts low unit-wide memory pressure and may fail when the laptop is under memory pressure (inferred by Verifier 2).
- No QA recheck after live (Harout, 27 Oct).

## Release notes for users

- The server no longer freezes when heavy jobs fill memory.
- Each freeze now records its cause.
- A task stopped by a usage limit pauses and carries on by itself after the reset.
