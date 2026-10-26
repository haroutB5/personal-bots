import { Connection } from "@t3tools/client-runtime/connection";
import { makeShellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import { makeThreadSnapshotLoaderLayer } from "@t3tools/client-runtime/state/threads";
import { pullRequestDiffLoaderLayer } from "@t3tools/client-runtime/state/pull-requests";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  backgroundActivityObserverLayer,
  backgroundActivityReporterLayer,
} from "../lib/backgroundActivityReporter";
import { perfOptimizationOn } from "../features/personal/perfFlags";
import { PROVIDER_WORKSPACE_DATA_OMITTED } from "../features/personal/providerCatalogScope";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
  // Finished reasoning and long tool commands arrive as previews; the classic
  // timeline loads the rest on expand (threadFullText.ts).
  makeThreadSnapshotLoaderLayer({ textPreviews: () => perfOptimizationOn("text-previews") }),
  // The Bots app loads idle archived bot chats on demand (lazyThreadShells.ts).
  makeShellSnapshotLoaderLayer({
    omitArchivedBotChats: () => perfOptimizationOn("shell-omit-archived"),
  }),
  pullRequestDiffLoaderLayer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof backgroundActivityObserverLayer
  | typeof backgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
      omitProviderWorkspaceData: PROVIDER_WORKSPACE_DATA_OMITTED,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      backgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = backgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
