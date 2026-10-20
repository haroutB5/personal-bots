# Provider catalogue and registry-agent installer (release 2 groundwork)

Server only. Nothing here is registered with the server, an RPC, a driver or a
layer yet. This file lists what is built and what a later release must wire in.

Spec: `dev-team/design/hbots/provider-setup/SPEC.md` sections 11.1, 11.2, 11.6 and 16.

## What is here

| File                                          | What it does                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry.ts`                                 | Decodes the ACP registry. One bad agent is skipped and counted; a document with no usable agent is `null` (the caller keeps its cached copy). Exact-version npm specs only.                                                                          |
| `overlay.ts`, `provider-catalog-overlay.json` | The overlay (cost, sign-in label, Popular rank, hidden, API-key/env presets, `sha256Pins`). Bundled copy plus an optional newer remote copy, newer by `updatedAt`.                                                                                   |
| `plan.ts`                                     | Which distribution this machine installs, or why none (`noChecksum`, `needsUv`, `needsNode`, ...). Command, env and argument vetting. Disk constants. One function for the catalogue and the installer, so a row that says Install can be installed. |
| `entries.ts`                                  | Builds `ProviderCatalogEntry[]` (built-ins plus registry, registry copies of built-ins dropped, hidden entries dropped, Popular first then A to Z).                                                                                                  |
| `ProviderCatalog.ts`                          | Service: daily registry fetch, last good copy on disk (`<stateDir>/provider-catalog.json`), HEAD size probes, reviewed-SVG icon proxy, `list`, `installRequest`, `installPlan`, `installFacts`.                                                      |
| `transport.ts`                                | HTTPS-only fetching. Every redirect hop is checked (no HTTP, no user:password, no private or loopback address). Errors name the host, never the URL.                                                                                                 |
| `archive.ts`                                  | Bounded unpacking of `.zip`, `.tar.gz`/`.tgz` and a bare executable: path traversal, symlinks, hard links, encrypted members, duplicates, entry and byte limits.                                                                                     |
| `installer.ts`                                | Generic installer for binary archives (sha256 checked before unpack) and npm packages (exact pinned version, integrity recorded and required). State stream, cancel, one previous version kept, Go back, Remove, leases.                             |
| `acpSmoke.ts`                                 | The launch check: start the agent and send ACP `initialize`, nothing else.                                                                                                                                                                           |
| `launch.ts`                                   | Trimmed environment, Node and `npm-cli.js` lookup, spawn input for the ACP runtime.                                                                                                                                                                  |
| `errors.ts`                                   | `CatalogInstallError` with the failure kinds of SPEC 11.2, URL redaction, one safe line.                                                                                                                                                             |
| `packages/contracts/src/providerCatalog.ts`   | Wire schemas: entry, list, add, install failure, install state (with `resolving`/`starting` phases and `previousVersion`), install plan.                                                                                                             |

On disk, per agent: `<runtimesRoot>/<catalogId>/<version>/` (agent files plus
`.install-complete.json`, written last) and `<runtimesRoot>/<catalogId>/active.json`
(`{version, previousVersion}`, replaced by an atomic rename: the commit).
A folder without the record is a partial install and is swept.

## Wiring for a later release (CTO to schedule after release 1 merges)

1. **Contracts.** Fold `ProviderCatalogInstallState` into `providerSetup.ts`
   (`ProviderInstallState`: phases `resolving` and `starting`, `failure`,
   `previousVersion`) or keep it as the state of catalogue instances. Fold the
   extra unsupported reasons (`noChecksum`, `unpinnedVersion`,
   `unsupportedArchive`, `badDistribution`) into the phone copy.
2. **RPCs** (`rpc.ts` `WS_METHODS` + handlers): `providerCatalogList`
   (`provider.catalog.list`, `ProviderCatalogListInput` to `ProviderCatalogListResult`),
   `providerCatalogAdd` (`provider.catalog.add`, creates the instance; see 4),
   `providerCatalogInstallFacts` (the install sheet; `ProviderCatalogInstallPlan`).
   Route the existing `providerInstallStart/Cancel/Subscribe/Remove` of a
   registry instance to `CatalogInstaller.start/cancel/changes/remove`
   (`start` takes the `installRequest` from `ProviderCatalog`). Add Go back
   (`CatalogInstaller.goBack`; SPEC 11.5 puts it on `serverUpdateProvider.toVersion`).
3. **Owner only.** `providerInstallStart`, `providerCatalogAdd` and Remove must
   require the owner's session, never a bot's (SPEC 11.6). The installer itself
   does not know who is calling.
4. **Generic ACP driver.** A new `Drivers/RegistryAcpDriver.ts` registered in
   `builtInDrivers.ts` (instance config `{ catalogId }`). To launch a session:
   `CatalogInstaller.acquire(catalogId)` (holds a lease so Remove and prune wait),
   then `toSpawnInput(installed, { nodePath, hostEnvironment, extraEnv, inheritEnvironment })`
   from `launch.ts`, then `AcpSessionRuntime` (priority lowering and tree kill
   already happen there). `extraEnv` is where overlay `env` presets and a saved
   API key go (release 3). Start the agent with `clientCapabilities.auth.terminal`
   when reading `authMethods` for sign-in (release 3); the launch check does not.
5. **`ServerProvider` fields (SPEC 11.3).** `catalogId, source, publisher, license,
openSource, iconUrl, addedByUser, setup, install, previousVersion` come from
   `ProviderCatalog` entries and `CatalogInstaller.state`. Not done here: the
   snapshot type belongs to release 1.
6. **Layers.** In the server layer stack provide `ProviderCatalog`
   (`stateDirectory: config.stateDir`, `added` from the provider instance
   settings, `networkAllowed` from `enableProviderUpdateChecks`) and
   `CatalogInstaller` (`runtimesRoot: <home>/.personal-bots/runtimes/acp`). Both
   need `FetchHttpClient`, `FileSystem`, `Path`, `Crypto` and `ChildProcessSpawner`
   (the installer also reads `HostProcess*`). The factories are
   `makeProviderCatalog` and `makeCatalogInstaller`; the `Context.Service`
   classes exist, a `Layer.effect` wrapper is two lines each.
7. **Icon route.** `GET /api/provider-catalog/icon/:catalogId` returning
   `ProviderCatalog.icon` with `Content-Type: image/svg+xml`,
   `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
   `X-Content-Type-Options: nosniff` and a day of caching; signed-in users only.
   `iconUrlFor` in `ProviderCatalogOptions` changes the path.
8. **Boot.** Call `ProviderCatalog.refresh()` once in the background after start
   (it is also triggered by the first `list`).
9. **Overlay hosting.** The remote model manifest the server fetches is
   `raw.githubusercontent.com/pingdotgg/t3code/main/...`, upstream's file, so the
   overlay cannot ride in it. The overlay is bundled (`provider-catalog-overlay.json`)
   and `overlayUrl` can point at a copy we host. Decision needed.
10. **Remove protection.** `CatalogInstaller.remove` refuses while a lease is
    held. The caller should also refuse while a bot's provider instance uses it
    (the Antigravity remove path does this for custom paths).

## Notes for QA and Security

- Network: HTTPS only, every redirect hop checked, host-only errors. Tested
  against a real loopback server with the real Fetch client (`transport.test.ts`).
- Downloads: sha256 compared before unpack; a mismatch deletes the file and the
  folder. Unpack limits scale with the download (at most 6 GiB).
- npm: install scripts run (SPEC section 16, decision 3). npm gets a trimmed
  environment (no server secrets), an empty user and global `.npmrc`, and the
  public registry forced; the lock file must carry an integrity hash for the
  pinned package from that registry.
- Agents and the launch check get the trimmed environment, never the server's.
- Live proof: `catalogLive.test.ts`, off unless `HBOTS_CATALOG_LIVE=1`.
