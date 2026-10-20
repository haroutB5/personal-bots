import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * Catalogue list query atom family.
 * Hits provider.catalog.list on the connected environment.
 */
export const providerCatalogList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "provider-catalog:list",
  tag: WS_METHODS.providerCatalogList,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

/**
 * Command to create a provider instance from a catalogue ID.
 * Returns { instanceId }.
 */
export const providerCatalogAdd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "provider-catalog:add",
  tag: WS_METHODS.providerCatalogAdd,
});

/**
 * Query for install facts (for the install confirmation sheet).
 */
export const providerCatalogInstallFacts = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "provider-catalog:install-facts",
    tag: WS_METHODS.providerCatalogInstallFacts,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  },
);
