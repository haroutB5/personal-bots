import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

type EnvironmentUnaryRpcTag = Parameters<typeof createEnvironmentRpcCommand>[1]["tag"];
const CATALOG_LIST_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogList ??
  "provider.catalog.list") as EnvironmentUnaryRpcTag;
const CATALOG_ADD_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogAdd ??
  "provider.catalog.add") as EnvironmentUnaryRpcTag;
const CATALOG_FACTS_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogInstallFacts ??
  "provider.catalog.installFacts") as EnvironmentUnaryRpcTag;

/**
 * Catalogue list query atom family.
 * Hits provider.catalog.list on the connected environment.
 */
export const providerCatalogList: (target: {
  readonly environmentId: any;
  readonly input: { readonly refresh?: boolean };
}) => any = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "provider-catalog:list",
  tag: CATALOG_LIST_METHOD,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

/**
 * Command to create a provider instance from a catalogue ID.
 * Returns { instanceId }.
 */
export const providerCatalogAdd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "provider-catalog:add",
  tag: CATALOG_ADD_METHOD,
});

/**
 * Query for install facts (for the install confirmation sheet).
 */
export const providerCatalogInstallFacts: (target: {
  readonly environmentId: any;
  readonly input: { readonly catalogId: string };
}) => any = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "provider-catalog:install-facts",
  tag: CATALOG_FACTS_METHOD,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});
