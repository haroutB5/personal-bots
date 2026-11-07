import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import { PersonalTurnContext } from "../turnContext/PersonalTurnContext.ts";
import { PersonalPrewarmSession, layer as prewarmLayer } from "./PersonalPrewarmSession.ts";

const THREAD = ThreadId.make("thread-1");
const PROVIDER_THREAD = ProviderThreadId.make("provider-thread-1");
const PROVIDER_SESSION = ProviderSessionId.make("provider-session-1");
const selection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "opus",
};

const projection = (input?: { readonly archived?: boolean; readonly active?: boolean }) => ({
  thread: {
    id: THREAD,
    deletedAt: null,
    archivedAt: input?.archived === true ? DateTime.makeUnsafe("2026-11-01T00:00:00.000Z") : null,
    activeProviderThreadId: input?.active === false ? null : PROVIDER_THREAD,
  },
  providerThreads: [
    {
      id: PROVIDER_THREAD,
      providerSessionId: PROVIDER_SESSION,
      nativeThreadRef: { driver: "claudeAgent", nativeId: "native-1" },
    },
  ],
  providerSessions: [{ id: PROVIDER_SESSION, driver: "claudeAgent" }],
});

const setup = (options?: {
  readonly archived?: boolean;
  readonly live?: boolean;
  readonly instructions?: string;
  readonly projectionThrows?: boolean;
}) => {
  const opens: Array<Record<string, unknown>> = [];
  const layer = prewarmLayer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () =>
          Effect.succeed(projection({ archived: options?.archived === true }).thread),
        getThreadRecords: () =>
          options?.projectionThrows === true
            ? Effect.die("projection unavailable")
            : Effect.succeed(projection({ archived: options?.archived === true })),
      } as never),
    ),
    Layer.provide(
      Layer.mock(RuntimePolicyV2)({
        resolve: () => Effect.succeed({ cwd: "/tmp/work" }),
      } as never),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        isLive: () => Effect.succeed(options?.live === true),
        open: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            opens.push(input);
            return {};
          }),
      } as never),
    ),
    Layer.provide(
      Layer.mock(PersonalTurnContext)({
        sessionInstructions: () =>
          Effect.succeed(
            options?.instructions === undefined ? Option.none() : Option.some(options.instructions),
          ),
        sessionPersonal: () =>
          Effect.succeed({
            personalBot: true,
            personalBotId: "bot-1",
            personalTaskChat: false,
            secretEnvironment: undefined,
          }),
      } as never),
    ),
  );

  const run = Effect.gen(function* () {
    const service = yield* PersonalPrewarmSession;
    return yield* service.prewarm({ threadId: THREAD, modelSelection: selection });
  }).pipe(Effect.provide(layer));
  return { run, opens };
};

describe("personal prewarm session", () => {
  it.effect("opens the chat's existing provider session with its bot instructions", () => {
    const { run, opens } = setup({ instructions: "You are Builder." });
    return Effect.gen(function* () {
      expect(yield* run).toBe("started");
      expect(opens).toHaveLength(1);
      expect(opens[0]?.providerSessionId).toBe(PROVIDER_SESSION);
      expect(opens[0]?.systemInstructions).toBe("You are Builder.");
      expect(opens[0]?.initialNativeThreadId).toBe("native-1");
    });
  });

  it.effect("does not open a session that is already live", () => {
    const { run, opens } = setup({ live: true });
    return Effect.gen(function* () {
      expect(yield* run).toBe("live");
      expect(opens).toHaveLength(0);
    });
  });

  it.effect("refuses an archived chat", () => {
    const { run, opens } = setup({ archived: true });
    return Effect.gen(function* () {
      expect(yield* run).toBe("archived");
      expect(opens).toHaveLength(0);
    });
  });

  it.effect("reports a failed projection as failed instead of dying", () => {
    const { run } = setup({ projectionThrows: true });
    return Effect.gen(function* () {
      expect(yield* run).toBe("failed");
    });
  });
});
