import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type PersonalBot,
  type ServerProviderAutoUpdate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalProviders from "../engine/PersonalProviders.ts";
import type { PersonalServerProvider } from "../engine/PersonalProviders.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import * as ProviderMaintenanceRunner from "../../provider/providerMaintenanceRunner.ts";
import * as PersonalProviderUpdates from "./PersonalProviderUpdates.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");
const NOW = "2026-11-12T00:00:00.000Z";

const provider = (version: string, latest: string): PersonalServerProvider => ({
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: "claude-opus-5",
      name: "Opus 5",
      isDefault: true,
      capabilities: [],
    } as never,
  ],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: version,
    latestVersion: latest,
    updateCommand: "mise install claude@latest",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt: NOW,
    message: null,
  },
});

const bot = {
  modelSelection: { instanceId: INSTANCE, model: "claude-opus-5" },
} as unknown as PersonalBot;

it.effect("the layer's auto-update reaches the shared runner and lands as updated", () => {
  const calls: Array<string> = [];
  const projected: Array<ServerProviderAutoUpdate | null> = [];
  const updated = provider("2.2.0", "2.2.0");
  const layer = PersonalProviderUpdates.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PersonalProviders.PersonalProviders)({
          listProviders: () => Effect.succeed([provider("2.1.0", "2.2.0")]),
          refreshInstance: () => Effect.succeed([updated]),
          setSmokeCheck: () => Effect.void,
          setAutoUpdate: (_instanceId, state) =>
            Effect.sync(() => {
              projected.push(state);
            }),
          listSessions: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          sessionEvents: Stream.empty,
          smokeTestFor: () => Effect.succeed(Option.some(() => Effect.void)),
        }),
        Layer.mock(PersonalEngine.PersonalEngine)({}),
        Layer.mock(PersonalBotRepository.PersonalBotRepository)({
          listBots: () => Effect.succeed([bot]),
          getMeta: () => Effect.succeed(Option.none()),
          setMeta: () => Effect.void,
          getThreadLink: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(PersonalPushService.PersonalPushService)({}),
        Layer.succeed(ProviderMaintenanceRunner.ProviderMaintenanceRunner, {
          updateProvider: (target) =>
            Effect.sync(() => {
              calls.push(typeof target === "string" ? target : target.provider);
              return { providers: [updated] };
            }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const updates = yield* PersonalProviderUpdates.PersonalProviderUpdates;

    yield* updates.autoUpdatePass;

    assert.deepStrictEqual(calls, ["claudeAgent"]);
    const last = projected.at(-1);
    assert.strictEqual(last?.status, "updated");
    assert.strictEqual(last?.message, "Updated automatically.");
  }).pipe(Effect.provide(layer), Effect.scoped);
});
