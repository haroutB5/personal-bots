/**
 * The v2 provider port, stubbed until C5 to C9 fill it in.
 *
 * Every method dies with the same marker, so a call that reaches the port
 * before its fill-in fails by name.
 *
 * @module personal/engine/PersonalProvidersV2Live
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PersonalProviders, type PersonalProvidersShape } from "./PersonalProviders.ts";

const pending = (method: string) => Effect.die(`v2-port pending: PersonalProviders.${method}`);

const shape: PersonalProvidersShape = {
  listProviders: () => pending("listProviders"),
  refreshInstance: () => pending("refreshInstance"),
  invalidateUsage: () => pending("invalidateUsage"),
  listSessions: () => pending("listSessions"),
  stopSession: () => pending("stopSession"),
  streamChanges: Stream.die("v2-port pending: PersonalProviders.streamChanges"),
  setSmokeCheck: () => pending("setSmokeCheck"),
  sessionEvents: Stream.die("v2-port pending: PersonalProviders.sessionEvents"),
  structuredGenerator: () => pending("structuredGenerator"),
  smokeTestFor: () => pending("smokeTestFor"),
  prewarm: () => pending("prewarm"),
};

export const PersonalProvidersV2Live = Layer.succeed(PersonalProviders, shape);
