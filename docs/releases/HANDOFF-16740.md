# 1.67.40: a sealed secret store whose key does not open fails safe

Based on 1.67.39 (`0130b5adf7b1`, trunk `2b13d0dfaf`). Trunk is `e9a58f66b1` with `fix/secret-store-locked` (`7c8b50b71d46`, two commits) merged on top, then a version commit and a gate scope commit. The only change from 1.67.39 in shipped code is under `apps/server/src/auth`, `apps/server/src/cli` and `apps/server/src/personal/secrets`. The schema stays at 160. There is no web change and no new APK.

## Why

After the laptop move the secrets folder was copied byte for byte. It holds 13 sealed values and a data key wrapped for the old machine. The store reported a generic secure failure, and with the key file gone it could mint a second key over sealed values and strand them. Harout needs hbots to read those 13 values again without any path that loses them.

## What changed

- **The data key has three states** (`e15f68b85d`). Absent, open or locked. A locked store raises `SecretStoreLockedError` with a reason and the wrapping source, never writes, and recovers on the next access once a key file opens. A missing key file next to sealed files is locked too, so no key is minted.
- **Recovery commands.** `secrets status` reports locked or open with the sealed count. `secrets rewrap` re-wraps the key from the old machine's material, with a backup, a re-read proof and a restore on failure. `secrets import` works in place when every local entry opens with the bundle key.
- **Import never overwrites or deletes what it cannot prove safe** (`7c8b50b71d`). With no key file, import refuses with `target-key-differs` unless every local entry opens with the bundle key, and `--force` does not bypass it. A failed import restores the original bytes of every entry it overwrote and the key file, and removes its own key backup. A successful import that replaces the key keeps the old one as `data-encryption-key.json.locked-<iso>`.
- **Gate scope.** `qa/verify-skills/` (the recorded runs of the phone check script, already on trunk) joins `NO_CHECK` in `gateScope.mjs`. No check reads it, and an unmapped path stops the gate plan, which blocked the release gate on its PNG and text evidence files. Dev-team tooling only.
- **Locked message.** It says the key file is missing for the key-missing case, not "sealed on another machine".

## Expected boot log

Until the separate recovery step runs, the boot log shows one locked ERROR line with `reason=material-mismatch` and `sealed=13`. This is expected. The store is locked on purpose and nothing is written. The startup ERROR count in the live checks reads 1 for this line, so Shipper must not treat it as a failed release. The line goes away once `secrets rewrap` has run and the next access opens the store.

## Release notes for the phone

- Secrets stay safe after a move to a new laptop. A store that cannot be opened is locked and never overwritten.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server/src/persistence` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

- Verifier PASS on the first head: `qa/secret-store-move/verify/VERIFY.md`.
- Verifier 2 PASS on `7c8b50b71d46`: `qa/secret-store-move/verify-2/VERIFY.md`. Secret tests 170 of 170, cold tsc on all 5 shards exit 0, adversarial scripts A to D and throwaway server E1 to E3 all pass. The live `userdata/secrets` was never opened.
- Known and not blocking. A crafted bundle can write a `*.bin` file outside the secrets folder through `secretsPortability.ts:57`, `:432` and `:538`. The live release `0130b5adf7b1` has the same defect, so this is not a regression. It is a follow-up.
- Release prep evidence: `qa/secret-store-move/release-prep/`.

## Rollback

Binary rollback to `0130b5adf7b1` (1.67.39). No data change, so no data restore.

## Gate evidence

<!-- gate-evidence:begin sha=d93181fb33aa78efeeb340ec1819ed2a9771bf14 release=d93181fb33aa json-sha256=7c2a3b8ba841960a1b4b26f3d90e345ea30a7ef1dd51a1d639ccb7706030610d result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/scripts/secrets-roundtrip.ts, apps/server/src/auth/ServerSecretStore.test.ts, apps/server/src/auth/ServerSecretStore.ts, apps/server/src/auth/secretEncryption.ts, ...; selected 261 test files
- server-tsc: PASS, exit 0
- web-tests: SKIPPED, skip: no changed path is an input of web-tests: apps/web, packages
- web-tsc: SKIPPED, skip: no changed path is an input of web-tsc: apps/web, packages
- e2e: PASS, selected: e2e inputs changed: apps/server/scripts/secrets-roundtrip.ts, apps/server/src/auth/ServerSecretStore.test.ts, apps/server/src/auth/ServerSecretStore.ts, apps/server/src/auth/secretEncryption.ts, ...; selected 12 journeys
- personal-client: SKIPPED, skip: no changed path is an input of personal-client: packages/personal-client, packages/client-runtime, packages/contracts, packages/shared
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: SKIPPED, skip: no changed path is an input of hbots-mobile-kotlin: apps/hbots-mobile/modules/_/android, apps/hbots-mobile/modules/_/expo-module.config.json, apps/hbots-mobile/plugins, apps/hbots-mobile/app.config.ts
- parity: PASS, exit 0
- release-tools: PASS, selected: release-tools inputs changed: scripts/personal/linux/hbots-release/lib/gateScope.mjs; selected 15 test files
- not run by any gate: apps/server/src/auth/ServerSecretStore.test.ts
- not run by any gate: scripts/personal/testing/fake-claude/cli.test.mjs

<!-- gate-evidence:end -->
