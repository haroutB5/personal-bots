/**
 * Mise-managed provider helpers.
 *
 * The shared provider resolver owns mise ownership, so this module keeps the
 * trunk import path the personal provider updater uses and re-exports the one
 * implementation from provider-core.
 *
 * @module personal/providerUpdates/miseProviderMaintenance
 */
export {
  isStableMiseVersion,
  listMiseInstalledVersions,
  miseInstallDirFromLatestPath,
  miseVersionsNewerThan,
  resolveMiseLatestVersion,
  resolveMiseOwnership,
  type MiseOwnership,
} from "@t3tools/provider-core/server/miseProviderMaintenance";
