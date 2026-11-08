/** The engine seam: D3 and D5 fill the two branches; D2 answers with shared ACP capabilities. */
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import type { DeepSeekEngine } from "./engine.ts";

const DRIVER_KIND = ProviderDriverKind.make("deepseek");

export interface DeepSeekEngineAdapterInput {
  readonly instanceId: ProviderInstanceId;
  readonly engine: DeepSeekEngine;
}

export const makeDeepSeekEngineAdapter = (
  input: DeepSeekEngineAdapterInput,
): Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"]> =>
  Effect.succeed(
    ProviderAdapter.ProviderAdapterV2.of({
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      getCapabilities: Effect.fn("ProviderAdapter.ProviderAdapterV2.getCapabilities")(() =>
        Effect.succeed(AcpProviderCapabilitiesV2),
      ),
      planSelectionTransition: Effect.fn(
        "ProviderAdapter.ProviderAdapterV2.planSelectionTransition",
      )(() => Effect.succeed(turnScopedSelectionTransition())),
      openSession: Effect.fn("ProviderAdapter.ProviderAdapterV2.openSession")((session) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: DRIVER_KIND,
            providerSessionId: session.providerSessionId,
          }),
        ),
      ),
    }),
  );
