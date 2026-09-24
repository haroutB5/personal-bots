import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PERSONAL_BOT_MUTED_INDEFINITELY_ISO,
  PersonalBotId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";

const makeProviderSnapshot = (input: {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex" | "grok";
  readonly defaultModel: string;
}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: [
      {
        slug: input.defaultModel,
        name: input.defaultModel,
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  }) as unknown as ServerProvider;

const claudeSnapshot = () =>
  makeProviderSnapshot({
    instanceId: "claude",
    driver: "claudeAgent",
    defaultModel: "claude-fable-5-1",
  });

const codexSnapshot = () =>
  makeProviderSnapshot({ instanceId: "codex", driver: "codex", defaultModel: "gpt-6-astra" });

/** A ready provider whose adapter drops `systemInstructions` (ACP; no persona). */
const grokSnapshot = () =>
  makeProviderSnapshot({ instanceId: "grok", driver: "grok", defaultModel: "grok-4" });

interface PersonalBotsTestContext {
  readonly snapshots: Array<ServerProvider>;
  readonly dispatched: Array<OrchestrationCommand>;
}

const makeContext = (snapshots: ReadonlyArray<ServerProvider> = []): PersonalBotsTestContext => ({
  snapshots: [...snapshots],
  dispatched: [],
});

const makeTestLayer = (context: PersonalBotsTestContext) =>
  PersonalBotService.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            context.dispatched.push(command);
            return { sequence: context.dispatched.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.sync(() => [...context.snapshots]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-bots-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const botInput = (botId: string) =>
  ({
    botId: PersonalBotId.make(botId),
    name: "Helper",
    title: "Helper bot",
    description: "Helps with things.",
    instructions: "Be helpful.",
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
    },
  }) as const;

it.effect(
  "create then list round-trips the bot; recreating the same botId returns the existing bot",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const created = yield* service.create(botInput("bot-1"));
      const listed = yield* service.list();
      expect(listed.bots.length).toBe(1);
      expect(listed.bots[0]?.botId).toBe(created.botId);
      expect(listed.bots[0]?.title).toBe("Helper bot");
      expect(listed.bots[0]?.avatarShape).toBe("blob");
      expect(listed.bots[0]?.avatarColor).toBe("#1A73E8");
      expect(listed.bots[0]?.modelSelection.instanceId).toBe("codex");
      expect(listed.bots[0]?.modelSelection.model).toBe("gpt-6-astra");
      // The list adds what it derives (group presence) on top of the stored bot.
      expect(listed.bots[0]).toEqual({ ...created, groupIds: [], groupOnly: false });

      const again = yield* service.create(botInput("bot-1"));
      expect(again.botId).toBe(created.botId);
      const relisted = yield* service.list();
      expect(relisted.bots.length).toBe(1);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect("update changes name and avatar; delete hides the bot from list", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const created = yield* service.create(botInput("bot-2"));
    const updated = yield* service.update({
      botId: created.botId,
      name: "Renamed",
      avatarShape: "pill",
      avatarColor: "#000000",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.avatarShape).toBe("pill");
    expect(updated.avatarColor).toBe("#000000");
    // An update that omits title keeps it.
    expect(updated.title).toBe("Helper bot");

    const retitled = yield* service.update({ botId: created.botId, title: "  Engineer  " });
    expect(retitled.title).toBe("Engineer");
    expect(retitled.name).toBe("Renamed");
    const cleared = yield* service.update({ botId: created.botId, title: "" });
    expect(cleared.title).toBe("");
    expect((yield* service.list()).bots[0]?.title).toBe("");

    const { title: _title, ...untitledInput } = botInput("bot-2b");
    const untitled = yield* service.create(untitledInput);
    expect(untitled.title).toBe("");

    yield* service.remove({ botId: created.botId });
    const listed = yield* service.list();
    expect(listed.bots.map((bot) => bot.botId)).toEqual([untitled.botId]);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

// The standing permission to save memories is on for a new bot unless the
// owner turns it off, and an edit that does not mention it leaves it as it was.
it.effect("stores the save-memories-without-asking setting per bot", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;

    const plain = yield* service.create({ ...botInput("bot-plain"), memoryAutoSave: false });
    expect(plain.memoryAutoSave).toBe(false);

    const byDefault = yield* service.create(botInput("bot-default"));
    expect(byDefault.memoryAutoSave).toBe(true);

    const cfo = yield* service.create({ ...botInput("bot-cfo"), memoryAutoSave: true });
    expect(cfo.memoryAutoSave).toBe(true);

    const renamed = yield* service.update({ botId: cfo.botId, name: "CFO" });
    expect(renamed.memoryAutoSave).toBe(true);

    const turnedOn = yield* service.update({ botId: plain.botId, memoryAutoSave: true });
    expect(turnedOn.memoryAutoSave).toBe(true);
    const turnedOff = yield* service.update({ botId: plain.botId, memoryAutoSave: false });
    expect(turnedOff.memoryAutoSave).toBe(false);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

// Notifications are on for every bot until the owner mutes one. The server
// turns the request into a time from its own clock, and an edit that does not
// mention the mute leaves it as it was.
it.effect("stores a per-bot notification mute: timed, indefinite, back on", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const bot = yield* service.create(botInput("bot-mute"));
    expect(bot.notificationsMutedUntil).toBeNull();

    const now = yield* DateTime.now;
    const hour = yield* service.update({ botId: bot.botId, notificationsMute: { forMinutes: 60 } });
    expect(DateTime.formatIso(hour.notificationsMutedUntil!)).toBe(
      DateTime.formatIso(DateTime.add(now, { minutes: 60 })),
    );
    const renamed = yield* service.update({ botId: bot.botId, name: "Quiet" });
    expect(renamed.notificationsMutedUntil).toEqual(hour.notificationsMutedUntil);

    const forever = yield* service.update({
      botId: bot.botId,
      notificationsMute: "indefinitely",
    });
    expect(DateTime.formatIso(forever.notificationsMutedUntil!)).toBe(
      PERSONAL_BOT_MUTED_INDEFINITELY_ISO,
    );
    expect((yield* service.list()).bots[0]?.notificationsMutedUntil).toEqual(
      forever.notificationsMutedUntil,
    );

    const on = yield* service.update({ botId: bot.botId, notificationsMute: "on" });
    expect(on.notificationsMutedUntil).toBeNull();
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it("turns a mute request into the stored time", () => {
  const now = DateTime.makeUnsafe("2026-09-24T12:00:00.000Z");
  expect(PersonalBotService.notificationsMutedUntilFor("on", now)).toBeNull();
  expect(
    DateTime.formatIso(PersonalBotService.notificationsMutedUntilFor({ forMinutes: 480 }, now)!),
  ).toBe("2026-09-24T20:00:00.000Z");
  expect(
    DateTime.formatIso(PersonalBotService.notificationsMutedUntilFor("indefinitely", now)!),
  ).toBe(PERSONAL_BOT_MUTED_INDEFINITELY_ISO);
});

// Each team has exactly one lead, so promoting a bot has to demote whoever
// led that team before — including when the promotion also moves the bot
// across teams.
it.effect("keeps one lead per team, and defaults a new bot to the assistant's team", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;

    const cto = yield* service.create({
      ...botInput("bot-cto"),
      team: "dev",
      lead: true,
      pinned: true,
    });
    expect([cto.team, cto.lead, cto.pinned]).toEqual(["dev", true, true]);

    // No team named: the assistant's team, an ordinary member, unpinned.
    const scout = yield* service.create(botInput("bot-scout"));
    expect([scout.team, scout.lead, scout.pinned]).toEqual(["assistant", false, false]);

    const assistant = yield* service.create({ ...botInput("bot-assistant"), lead: true });
    expect([assistant.team, assistant.lead]).toEqual(["assistant", true]);

    // Moving Scout to the dev team as its lead demotes the CTO and leaves the
    // assistant's lead alone.
    const promoted = yield* service.update({
      botId: PersonalBotId.make("bot-scout"),
      team: "dev",
      lead: true,
    });
    expect([promoted.team, promoted.lead]).toEqual(["dev", true]);

    const listed = yield* service.list();
    expect(
      listed.bots
        .filter((bot) => bot.lead === true)
        .map((bot) => [bot.botId, bot.team])
        .toSorted(),
    ).toEqual([
      ["bot-assistant", "assistant"],
      ["bot-scout", "dev"],
    ]);
    expect(listed.bots.find((bot) => bot.botId === "bot-cto")?.lead).toBe(false);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect("seedDefaultsIfNeeded creates the four default bots once, even after a delete", () => {
  const context = makeContext([claudeSnapshot(), codexSnapshot()]);
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const seeded = yield* service.seedDefaultsIfNeeded;
    expect(seeded.length).toBe(4);
    expect(
      seeded.map((bot) => [
        bot.name,
        bot.avatarShape,
        bot.avatarColor,
        bot.modelSelection.instanceId,
        bot.modelSelection.model,
      ]),
    ).toEqual([
      ["Assistant", "blob", "#1A73E8", "claude", "claude-fable-5-1"],
      ["Developer", "roundedHexagon", "#F26A1B", "codex", "gpt-6-astra"],
      ["Researcher", "scallopedCloud", "#F0457E", "codex", "gpt-6-astra"],
      ["Planner", "roundedSquare", "#E5323B", "claude", "claude-fable-5-1"],
    ]);
    expect(seeded.map((bot) => bot.title)).toEqual([
      "Personal assistant",
      "Engineer",
      "Research analyst",
      "Planner",
    ]);

    expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    yield* service.remove({ botId: seeded[1]!.botId });
    expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    const listed = yield* service.list();
    expect(listed.bots.length).toBe(3);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect(
  "seeding waits for a provider and then puts every bot on the one available instance",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      // No provider yet: nothing seeded, and the flag stays unset so a later
      // provider still triggers the seed.
      expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
      expect((yield* service.list()).bots.length).toBe(0);

      context.snapshots.push(codexSnapshot());
      const seeded = yield* service.seedDefaultsIfNeeded;
      expect(seeded.length).toBe(4);
      for (const bot of seeded) {
        expect(bot.modelSelection.instanceId).toBe("codex");
        expect(bot.modelSelection.model).toBe("gpt-6-astra");
      }
      expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect(
  "seeding skips a provider that cannot carry bot instructions and waits for one that can",
  () => {
    // Grok is ready and would be `available[0]`, but its ACP adapter never
    // passes `systemInstructions`, so a bot seeded onto it would answer as
    // the bare model with no name and no app rules.
    const context = makeContext([grokSnapshot()]);
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
      expect((yield* service.list()).bots.length).toBe(0);

      // The seeded flag stayed unset, so a real provider still seeds later.
      context.snapshots.push(claudeSnapshot());
      const seeded = yield* service.seedDefaultsIfNeeded;
      expect(seeded.length).toBe(4);
      for (const bot of seeded) {
        expect(bot.modelSelection.instanceId).toBe("claude");
      }
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect(
  "createThread twice with the same threadId links once and dispatches thread.create once",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const created = yield* service.create(botInput("bot-3"));
      const threadId = ThreadId.make("thread-1");
      const first = yield* service.createThread({ botId: created.botId, threadId });
      const second = yield* service.createThread({ botId: created.botId, threadId });
      expect(second).toEqual(first);
      expect(first.botId).toBe(created.botId);
      expect(first.archivedAt).toBeNull();

      const listed = yield* service.list();
      expect(listed.threads.length).toBe(1);

      const threadCreates = context.dispatched.filter(
        (command) => command.type === "thread.create",
      );
      expect(threadCreates.length).toBe(1);
      expect(threadCreates[0]).toMatchObject({
        threadId,
        title: "New chat",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      });
      expect(context.dispatched.filter((command) => command.type === "project.create").length).toBe(
        1,
      );
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect("deleteThread dispatches thread.delete once and removes only that link", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const created = yield* service.create(botInput("bot-del"));
    const gone = ThreadId.make("thread-gone");
    const kept = ThreadId.make("thread-kept");
    yield* service.createThread({ botId: created.botId, threadId: gone });
    yield* service.createThread({ botId: created.botId, threadId: kept });

    yield* service.deleteThread({ threadId: gone });

    const deletes = context.dispatched.filter((command) => command.type === "thread.delete");
    expect(deletes.length).toBe(1);
    expect(deletes[0]).toMatchObject({
      threadId: gone,
      commandId: `personal-bots:thread.delete:${gone}`,
    });
    const listed = yield* service.list();
    expect(listed.threads.map((thread) => thread.threadId)).toEqual([kept]);
    // The bot row itself is untouched: only the one chat goes.
    expect(listed.bots.map((bot) => bot.botId)).toEqual([created.botId]);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect("deleteThread on an unknown thread fails without dispatching anything", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const failure = yield* Effect.flip(
      service.deleteThread({ threadId: ThreadId.make("thread-nope") }),
    );
    expect(failure.message).toContain("was not found");
    expect(context.dispatched.length).toBe(0);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect("profile display name defaults to empty, trims on set, and rejects long names", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    expect(yield* service.getProfile()).toEqual({ displayName: "" });

    expect(yield* service.setProfile({ displayName: "  Harout  " })).toEqual({
      displayName: "Harout",
    });
    expect(yield* service.getProfile()).toEqual({ displayName: "Harout" });

    expect(yield* service.setProfile({ displayName: "" })).toEqual({ displayName: "" });
    expect(yield* service.getProfile()).toEqual({ displayName: "" });

    const tooLong = yield* Effect.flip(service.setProfile({ displayName: "x".repeat(81) }));
    expect(tooLong.message).toContain("at most 80 characters");
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect(
  "custom teams persist empty, accept bots and leads, and can be removed when empty",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      yield* service.setProfile({ displayName: "Harout" });
      yield* service.setProfile({ teamChange: { operation: "create", name: " Research " } });
      yield* service.setProfile({ teamChange: { operation: "create", name: "research" } });
      expect(yield* service.getProfile()).toEqual({
        displayName: "Harout",
        customTeams: ["Research"],
      });
      yield* service.setProfile({ displayName: "Ht" });
      expect((yield* service.getProfile()).customTeams).toEqual(["Research"]);
      const first = yield* service.create({
        ...botInput("research-1"),
        team: "Research",
        lead: true,
      });
      const second = yield* service.create({
        ...botInput("research-2"),
        team: "Research",
        lead: true,
      });
      expect(
        (yield* service.list()).bots.filter((bot) => bot.lead).map((bot) => bot.botId),
      ).toEqual([second.botId]);
      const failure = yield* Effect.flip(
        service.setProfile({ teamChange: { operation: "delete", name: "Research" } }),
      );
      expect(failure.message).toContain("Move the team's bots");
      yield* service.update({ botId: first.botId, team: "assistant", lead: false });
      yield* service.update({ botId: second.botId, team: "assistant", lead: false });
      expect((yield* service.getProfile()).customTeams).toEqual(["Research"]);
      yield* service.setProfile({ teamChange: { operation: "delete", name: "Research" } });
      expect(yield* service.getProfile()).toEqual({ displayName: "Ht" });
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect(
  "team creation validates names and concurrent additions do not overwrite each other",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      for (const name of ["", " ", "x".repeat(61), "dev", "Dev team", "ASSISTANT'S TEAM"]) {
        const failure = yield* Effect.flip(
          service.setProfile({ teamChange: { operation: "create", name } }),
        );
        expect(failure.message.length).toBeGreaterThan(0);
      }
      yield* Effect.all(
        ["Research", "Finance"].map((name) =>
          service.setProfile({ teamChange: { operation: "create", name } }),
        ),
        { concurrency: "unbounded" },
      );
      expect((yield* service.getProfile()).customTeams?.toSorted()).toEqual([
        "Finance",
        "Research",
      ]);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect(
  "a bot stored under a different case of the team name still blocks the team's removal",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      yield* service.setProfile({ teamChange: { operation: "create", name: "Research" } });
      const bot = yield* service.create({ ...botInput("research-case"), team: "Research" });

      // A row written before the team existed, or by an older client: the
      // stored string differs from the registered team only in case. The
      // duplicate check is case-insensitive, so this bot IS on "Research".
      yield* repository.updateBot({
        botId: bot.botId,
        team: "RESEARCH",
        updatedAt: yield* DateTime.now,
      });

      const failure = yield* Effect.flip(
        service.setProfile({ teamChange: { operation: "delete", name: "Research" } }),
      );
      expect(failure.message).toContain("Move the team's bots");
      expect((yield* service.getProfile()).customTeams).toEqual(["Research"]);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect("create and update refuse a team that is not a built-in or registered team", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    yield* service.setProfile({ teamChange: { operation: "create", name: "Research" } });

    const typo = yield* Effect.flip(service.create({ ...botInput("typo"), team: "Reserch" }));
    expect(typo.message).toContain("'Reserch' is not a team");
    expect(typo.message).toContain("Research");
    expect(typo.message).toContain("Dev team");
    expect((yield* service.list()).bots.some((bot) => bot.botId === "typo")).toBe(false);

    // No team named is still the assistant's team, and a registered team is
    // accepted under the spelling it was registered with.
    const defaulted = yield* service.create(botInput("defaulted"));
    expect(defaulted.team).toBe("assistant");
    const joined = yield* service.create({ ...botInput("joined"), team: "research" });
    expect(joined.team).toBe("Research");

    const moved = yield* Effect.flip(service.update({ botId: joined.botId, team: "Marketing" }));
    expect(moved.message).toContain("'Marketing' is not a team");
    expect((yield* service.list()).bots.find((bot) => bot.botId === "joined")?.team).toBe(
      "Research",
    );

    const back = yield* service.update({ botId: joined.botId, team: "assistant" });
    expect(back.team).toBe("assistant");
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect("an undecodable customTeams row still serves the profile", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* service.setProfile({ displayName: "Harout" });
    yield* repository.setMeta({ key: "customTeams", value: "{not json" });

    // The greeting name is a separate row and must survive a corrupt one.
    expect(yield* service.getProfile()).toEqual({ displayName: "Harout" });

    // And the user can register a team again, which rewrites the bad row.
    yield* service.setProfile({ teamChange: { operation: "create", name: "Research" } });
    expect(yield* service.getProfile()).toEqual({
      displayName: "Harout",
      customTeams: ["Research"],
    });
  }).pipe(Effect.provide(makeTestLayer(context)));
});
