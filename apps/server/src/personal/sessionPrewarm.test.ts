import {
  type ModelSelection,
  type OrchestrationThreadShell,
  type PersonalBot,
  PersonalBotId,
  type PersonalBotThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderSessionPrewarmOutcome,
} from "../orchestration/Services/ProviderCommandReactor.ts";
import { PersonalGroupService } from "./groups/PersonalGroupService.ts";
import { PersonalBotRepository } from "./PersonalBotRepository.ts";
import {
  makePersonalSessionPrewarmer,
  type PersonalSessionPrewarmOutcome,
  sendModelSelection,
} from "./sessionPrewarm.ts";

const threadId = ThreadId.make("thread-1");
const botId = PersonalBotId.make("bot-1");
const claude = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
});

function setup(input?: {
  readonly link?: Partial<PersonalBotThread> | null;
  readonly group?: string;
  readonly botModel?: ModelSelection;
  readonly threadModel?: ModelSelection;
  readonly env?: Record<string, string>;
  readonly reactorOutcome?: Effect.Effect<ProviderSessionPrewarmOutcome>;
  readonly maxUnused?: number;
  readonly debounceMs?: number;
}) {
  /** Thread id -> when its latest turn was requested (none: never). */
  const turns = new Map<string, string>();
  const calls: Array<{ threadId: ThreadId; modelSelection: ModelSelection }> = [];
  const link: PersonalBotThread | null =
    input?.link === null
      ? null
      : {
          botId,
          threadId,
          createdAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
          archivedAt: null,
          ...input?.link,
        };
  const layer = Layer.mergeAll(
    Layer.mock(ProviderCommandReactor)({
      prewarmSession: (request) =>
        Effect.suspend(() => {
          calls.push(request);
          return input?.reactorOutcome ?? Effect.succeed("started" as const);
        }),
    }),
    Layer.mock(PersonalBotRepository)({
      getThreadLink: () => Effect.succeed(Option.fromNullOr(link)),
      getBotById: () =>
        Effect.succeed(
          Option.some({ botId, modelSelection: input?.botModel ?? claude("opus") } as PersonalBot),
        ),
    }),
    Layer.mock(PersonalGroupService)({
      groupNameForMemberThread: () => Effect.succeed(Option.fromNullOr(input?.group ?? null)),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            modelSelection: input?.threadModel ?? claude("sonnet"),
            // A session is up once a prewarm asked for it.
            session: calls.some((call) => call.threadId === id) ? { status: "ready" } : null,
            latestTurn: turns.has(id) ? { requestedAt: turns.get(id) } : null,
          } as unknown as OrchestrationThreadShell),
        ),
    }),
  );
  const run = <A>(
    use: (
      prewarm: (id: ThreadId) => Effect.Effect<PersonalSessionPrewarmOutcome>,
    ) => Effect.Effect<A>,
  ) =>
    makePersonalSessionPrewarmer({
      env: input?.env ?? {},
      debounceMs: input?.debounceMs ?? 60_000,
      ...(input?.maxUnused !== undefined ? { maxUnused: input.maxUnused } : {}),
    }).pipe(
      Effect.flatMap((prewarmer) => use(prewarmer.prewarm)),
      Effect.provide(layer),
    );
  return { calls, run, turns };
}

describe("personal session prewarm", () => {
  it.effect("prewarms a bot chat with the model the composer will send", () =>
    Effect.gen(function* () {
      const { calls, run } = setup({ botModel: claude("opus"), threadModel: claude("sonnet") });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("started");
      expect(calls).toEqual([{ threadId, modelSelection: claude("opus") }]);
    }),
  );

  it("uses the thread's model when the bot moved to another provider instance", () => {
    const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    expect(sendModelSelection(codex, claude("sonnet"))).toEqual(claude("sonnet"));
  });

  it.effect("asks once per chat within the debounce window", () =>
    Effect.gen(function* () {
      const { calls, run } = setup();

      const outcomes = yield* run((prewarm) =>
        Effect.all([prewarm(threadId), prewarm(threadId), prewarm(threadId)]),
      );

      expect(outcomes).toEqual(["started", "debounced", "debounced"]);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("does nothing when the kill switch is set", () =>
    Effect.gen(function* () {
      const { calls, run } = setup({ env: { PB_PERF_OFF: "rum, session-prewarm" } });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("disabled");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("skips a chat that is not a bot chat", () =>
    Effect.gen(function* () {
      const { calls, run } = setup({ link: null });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("not-a-bot-chat");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("skips an archived chat", () =>
    Effect.gen(function* () {
      const { calls, run } = setup({
        link: { archivedAt: DateTime.makeUnsafe("2026-09-02T00:00:00.000Z") },
      });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("archived");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("skips a bot's thread inside a group, which only group rounds drive", () =>
    Effect.gen(function* () {
      const { calls, run } = setup({ group: "Team" });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("group-member");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("stops prewarming while too many prewarmed sessions sit unused", () =>
    Effect.gen(function* () {
      const { calls, run, turns } = setup({ maxUnused: 1, debounceMs: 0 });
      const second = ThreadId.make("thread-2");

      const outcomes = yield* run((prewarm) =>
        Effect.gen(function* () {
          const first = yield* prewarm(threadId);
          const blocked = yield* prewarm(second);
          // The first chat gets a message: its session is no longer idle.
          turns.set(threadId, "2999-01-01T00:00:00.000Z");
          const allowed = yield* prewarm(second);
          return [first, blocked, allowed];
        }),
      );

      expect(outcomes).toEqual(["started", "too-many-unused", "started"]);
      expect(calls.map((call) => call.threadId)).toEqual([threadId, second]);
    }),
  );

  it.effect("reports a failed start instead of failing the caller", () =>
    Effect.gen(function* () {
      const { run } = setup({ reactorOutcome: Effect.die(new Error("spawn failed")) });

      expect(yield* run((prewarm) => prewarm(threadId))).toBe("failed");
    }),
  );
});
