/**
 * The personal server group as one layer: the runtime services and the three
 * personal reactors that start with them.
 *
 * @module personal/PersonalServerLayerLive
 */
import * as Layer from "effect/Layer";

import { PersonalRuntimeLayerLive } from "./PersonalLayerLive.ts";
import { PersonalBrowserArchiveReactorLive } from "./reactors/PersonalBrowserArchiveReactor.ts";
import { PersonalBrowserTurnReactorLive } from "./reactors/PersonalBrowserTurnReactor.ts";
import { PersonalTaskEndReactorLive } from "./reactors/PersonalTaskEndReactor.ts";

export const PersonalServerLayerLive = Layer.mergeAll(
  PersonalBrowserTurnReactorLive,
  PersonalBrowserArchiveReactorLive,
  PersonalTaskEndReactorLive,
).pipe(Layer.provideMerge(PersonalRuntimeLayerLive));
