import { PersonalBotId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";

const testLayer = PersonalBotRepository.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const decodeCreateBot = Schema.decodeSync(PersonalBotRepository.CreatePersonalBotInput);

const bot = (botId: string, input: { readonly pinned: boolean; readonly sortOrder: number }) =>
  decodeCreateBot({
    botId: PersonalBotId.make(botId),
    name: botId,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    team: "assistant",
    lead: false,
    pinned: input.pinned,
    sortOrder: input.sortOrder,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
  });

const pinOrders = (bots: ReadonlyArray<{ readonly botId: string; readonly pinOrder?: number }>) =>
  new Map(bots.map((entry) => [entry.botId, entry.pinOrder ?? null]));

it.effect("keeps pin_order set exactly while a bot is pinned", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const first = PersonalBotId.make("first");
    const second = PersonalBotId.make("second");
    const later = PersonalBotId.make("later");
    yield* repository.createBot(bot("first", { pinned: true, sortOrder: 0 }));
    yield* repository.createBot(bot("second", { pinned: true, sortOrder: 1 }));
    yield* repository.createBot(bot("later", { pinned: false, sortOrder: 2 }));

    expect(pinOrders(yield* repository.listBots())).toEqual(
      new Map([
        ["first", 0],
        ["second", 1],
        ["later", null],
      ]),
    );

    yield* repository.updateBot({
      botId: later,
      pinned: true,
      updatedAt: DateTime.makeUnsafe("2026-11-12T00:01:00.000Z"),
    });
    yield* repository.updateBot({
      botId: first,
      pinned: false,
      updatedAt: DateTime.makeUnsafe("2026-11-12T00:02:00.000Z"),
    });
    yield* repository.updateBot({
      botId: second,
      name: "Renamed",
      updatedAt: DateTime.makeUnsafe("2026-11-12T00:03:00.000Z"),
    });

    expect(pinOrders(yield* repository.listBots())).toEqual(
      new Map([
        ["first", null],
        ["second", 1],
        ["later", 2],
      ]),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reorders listed pins and keeps unlisted pins after them", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    for (const [index, botId] of ["a", "b", "c", "d"].entries()) {
      yield* repository.createBot(bot(botId, { pinned: true, sortOrder: index }));
    }
    yield* repository.createBot(bot("plain", { pinned: false, sortOrder: 4 }));

    yield* repository.reorderPinned({
      botIds: [
        PersonalBotId.make("d"),
        PersonalBotId.make("missing"),
        PersonalBotId.make("plain"),
        PersonalBotId.make("b"),
      ],
    });

    expect(pinOrders(yield* repository.listBots())).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
        ["c", 3],
        ["d", 0],
        ["plain", null],
      ]),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ignores a removed bot in the list and leaves the rest contiguous", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    for (const [index, botId] of ["a", "b", "c"].entries()) {
      yield* repository.createBot(bot(botId, { pinned: true, sortOrder: index }));
    }
    yield* repository.softDeleteBot({
      botId: PersonalBotId.make("b"),
      deletedAt: DateTime.makeUnsafe("2026-11-12T00:01:00.000Z"),
    });

    yield* repository.reorderPinned({
      botIds: [PersonalBotId.make("b"), PersonalBotId.make("c")],
    });

    expect(pinOrders(yield* repository.listBots())).toEqual(
      new Map([
        ["a", 1],
        ["c", 0],
      ]),
    );
  }).pipe(Effect.provide(testLayer)),
);
