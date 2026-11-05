/**
 * `@effect/platform-node/NodeServices` plus the personal crypto service.
 *
 * Effect 4.1 removed the platform crypto service that NodeServices used to
 * carry. Every server, desktop and test layer that takes NodeServices also
 * needs `Crypto`, so this module keeps the old single import working.
 */
import * as PlatformNodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

import { Crypto, layer as cryptoLayer } from "./crypto.ts";

export type { NodeServices } from "@effect/platform-node/NodeServices";

export const layer = Layer.mergeAll(PlatformNodeServices.layer, cryptoLayer);
