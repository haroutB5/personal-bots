// App-scoped rules, conversation-aware retrieval and the rules cap warning (1.60.40).
import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { APP_SCOPING_ENV } from "./memoryApps.ts";
import { RELEVANT_MAX_CHARS, RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import {
  PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
  PersonalMemoryService,
  layer as memoryLayer,
} from "./PersonalMemoryService.ts";

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const BOT_A = PersonalBotId.make("bot-a");
const THREAD_A = ThreadId.make("thread-a");

/** Runs an effect with an environment switch set, then puts it back. */
const withEnv = <A, E, R>(name: string, value: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      process.env[name] = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

const linkThread = (title: string, botName = "Dev Bot") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at
      )
      VALUES (${BOT_A}, ${botName}, '', '', 'blob', '#1A73E8', '{}', 1, 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
      VALUES (${THREAD_A}, ${BOT_A}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at
      )
      VALUES (
        ${THREAD_A}, 'project-1', ${title}, '{"instanceId":"codex","model":"m"}',
        'full-access', 'default', ${now}, ${now}
      )
    `;
  });

const addMessage = (id: string, role: "user" | "assistant", text: string, secondsAgo: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { seconds: secondsAgo }));
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, ${THREAD_A}, NULL, ${role}, ${text}, 0, ${at}, ${at})
    `;
  });

const saveRule = (content: string, apps?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const memory = yield* PersonalMemoryService;
    return yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "preference",
      content,
      source: "user",
      ...(apps === undefined ? {} : { apps }),
    });
  });

const saveNote = (content: string, daysOld = 0, source = "user") =>
  Effect.gen(function* () {
    const memory = yield* PersonalMemoryService;
    const sql = yield* SqlClient.SqlClient;
    const entry = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      content,
      source,
    });
    const at = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: daysOld }));
    yield* sql`
      UPDATE personal_memory SET created_at = ${at}, updated_at = ${at}
      WHERE memory_id = ${entry.memoryId}
    `;
    return entry;
  });

const context = (
  query: string,
  extra: { readonly session?: { key: string; fresh: boolean } } = {},
) =>
  Effect.gen(function* () {
    const memory = yield* PersonalMemoryService;
    return yield* memory.contextForThread({
      threadId: THREAD_A,
      query,
      record: false,
      ...extra,
    });
  });

describe("app-scoped rules in a turn", () => {
  it.effect("lists global rules and the chat's app rules, and indexes the other apps", () =>
    Effect.gen(function* () {
      yield* linkThread("matchday");
      yield* saveRule("Always answer in plain words.");
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      yield* saveRule("Matchday half-time positions are kept all second half.", ["matchday"]);
      yield* saveRule("hbots Back goes to the Bots page.", ["personal-bots"]);
      yield* saveRule("CalTrack keeps the weight form value.", ["caltrack"]);

      const turn = yield* context("Check the dots");
      const block = turn.block ?? "";
      expect(block).toContain("Always answer in plain words.");
      expect(block).toContain("Matchday dots show the name only.");
      expect(block).toContain("half-time positions");
      expect(block).not.toContain("Back goes to the Bots page");
      expect(block).not.toContain("weight form value");
      // One line names the groups that were not listed, so none is unreachable.
      expect(block).toContain(
        "Rules for other apps are not listed here (CalTrack: 1 rule, hbots: 1 rule)",
      );
      expect(block).toContain("search_memory");
      expect(turn.trace?.activeApps.map((app) => app.slug)).toEqual(["matchday"]);
      expect(turn.trace?.rules).toEqual({ global: 1, scoped: 2 });
      expect(turn.trace?.appIndex).toEqual([
        { slug: "caltrack", count: 1 },
        { slug: "personal-bots", count: 1 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds the app from the chat title for a message like 'This works thx'", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots memory work");
      yield* saveRule("hbots Back goes to the Bots page.", ["personal-bots"]);
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      const turn = yield* context("This works thx");
      expect(turn.block).toContain("hbots Back goes to the Bots page.");
      expect(turn.block).not.toContain("Matchday dots show the name only.");
      expect(turn.block).toContain("Matchday: 1 rule");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds the app from the last turns when title and message name none", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      yield* addMessage("m1", "user", "Please look at the Matchday standings page", 60);
      yield* addMessage("m2", "assistant", "Looking at it now", 30);
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      const turn = yield* context("ok thanks");
      expect(turn.block).toContain("Matchday dots show the name only.");
      expect(turn.trace?.activeApps[0]?.via).toEqual(["recent"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("never drops a global rule: only an active app's overflow is left out, and named", () =>
    Effect.gen(function* () {
      yield* linkThread("matchday");
      const big = "g".repeat(1_900);
      for (let index = 0; index < 8; index++) yield* saveRule(`Global rule ${index} ${big}`);
      const scoped = yield* saveRule(`Matchday rule that no longer fits ${big}`, ["matchday"]);
      const turn = yield* context("dots");
      const block = turn.block ?? "";
      for (let index = 0; index < 8; index++) expect(block).toContain(`Global rule ${index} `);
      // The cap is 15k characters: 8 global rules take 15.2k, so the scoped one cannot fit.
      expect(block).not.toContain("Matchday rule that no longer fits gg");
      expect(block).toContain("1 rules for this chat's apps did not fit the per-turn limit");
      expect(block).toContain(`[${scoped.memoryId.slice(0, 8)}] Matchday rule that no longer fits`);
      expect(turn.trace?.rulesLeftOut).toEqual([scoped.memoryId]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps every global rule past the count cap", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      for (let index = 0; index < PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES + 5; index++) {
        yield* saveRule(`Standing rule number ${index}.`);
      }
      const turn = yield* context("anything");
      expect(turn.memoryIds).toHaveLength(PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES + 5);
      expect(turn.block).toContain("Standing rule number 0.");
      expect(turn.block).not.toContain("did not fit the per-turn limit");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("kill switch: with scoping off every rule is global and there is no index", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      yield* saveRule("Always answer in plain words.");
      const turn = yield* context("hello there");
      expect(turn.block).toContain("Matchday dots show the name only.");
      expect(turn.block).not.toContain("Rules for other apps");
    }).pipe((effect) => withEnv(APP_SCOPING_ENV, "off", effect), Effect.provide(TestLayer)),
  );

  it.effect(
    "the index line stays in the one-line reminder turns, and a changed index alone resends nothing",
    () =>
      Effect.gen(function* () {
        yield* linkThread("hbots");
        const memory = yield* PersonalMemoryService;
        yield* saveRule("Always answer in plain words.");
        yield* saveRule("Matchday dots show the name only.", ["matchday"]);
        const session = { key: "claude:1", fresh: true };
        const first = yield* context("hello", { session });
        expect(first.block).toContain("Always answer in plain words.");
        yield* memory.confirmPreferencesSent(THREAD_A);
        const second = yield* context("and again", { session: { ...session, fresh: false } });
        expect(second.block).toContain("still apply unchanged");
        expect(second.block).not.toContain("Always answer in plain words.");
        expect(second.block).toContain("Matchday: 1 rule");
        yield* memory.confirmPreferencesSent(THREAD_A);
        // A rule added for another app changes the index line, which every turn prints:
        // the list is not sent again for that.
        yield* saveRule("CalTrack keeps the weight form value.", ["caltrack"]);
        const third = yield* context("one more", { session: { ...session, fresh: false } });
        expect(third.block).toContain("still apply unchanged");
        expect(third.block).not.toContain("Always answer in plain words.");
        expect(third.block).toContain("CalTrack: 1 rule");
        expect(third.block).toContain("Matchday: 1 rule");
        yield* memory.confirmPreferencesSent(THREAD_A);
        // A new global rule does change what the session holds: the full list again.
        yield* saveRule("Never use em dashes.");
        const fourth = yield* context("and this", { session: { ...session, fresh: false } });
        expect(fourth.block).toContain("Always answer in plain words.");
        expect(fourth.block).toContain("Never use em dashes.");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a chat that flips between apps lists each app's rules once, not on every flip", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const memory = yield* PersonalMemoryService;
      yield* saveRule("Always answer in plain words.");
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      yield* saveRule("CalTrack keeps the weight form value.", ["caltrack"]);
      const session = { key: "claude:1", fresh: true };
      const turn = (query: string, fresh = false) =>
        context(query, { session: { ...session, fresh } }).pipe(
          Effect.tap(() => memory.confirmPreferencesSent(THREAD_A)),
        );

      const first = yield* turn("Look at the Matchday standings", true);
      expect(first.block).toContain("Always answer in plain words.");
      expect(first.block).toContain("Matchday dots show the name only.");
      expect(first.block).not.toContain("CalTrack keeps");

      // The chat moves to CalTrack: only that app's rule is sent, on top of the list there.
      const second = yield* turn("Now the CalTrack weight form");
      expect(second.block).toContain("still apply unchanged. This chat now also covers an app");
      expect(second.block).toContain("CalTrack keeps the weight form value.");
      expect(second.block).not.toContain("Always answer in plain words.");
      expect(second.block).not.toContain("Matchday dots show");
      expect(second.trace?.activeApps.map((app) => app.slug).toSorted()).toEqual([
        "caltrack",
        "matchday",
      ]);

      // And back to Matchday, then CalTrack again: nothing is sent again, the rules still apply.
      for (const query of ["Back to the Matchday dots", "And the CalTrack form again"]) {
        const flipped = yield* turn(query);
        expect(flipped.block).toContain("still apply unchanged; none were added");
        expect(flipped.block).not.toContain("CalTrack keeps the weight form value.");
        expect(flipped.block).not.toContain("Matchday dots show");
        expect(flipped.memoryIds).toEqual([]);
        expect(flipped.trace?.rules.scoped).toBe(2);
      }

      // A new session starts over: the apps it is about now, the full list.
      const next = yield* context("Look at the Matchday standings", {
        session: { key: "claude:2", fresh: true },
      });
      expect(next.block).toContain("Matchday dots show the name only.");
      expect(next.block).not.toContain("CalTrack keeps");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a page naming four other apps in an hbots chat does not hide hbots' rules", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      yield* saveRule("hbots Back goes to the Bots page.", ["personal-bots"]);
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      const turn = yield* context(
        "Here is a list: matchday, caltrack, rainhb, homegym, coachbuild are all fine.",
      );
      expect(turn.block).toContain("hbots Back goes to the Bots page.");
      expect(turn.block).toContain("Matchday dots show the name only.");
      expect(turn.trace?.activeApps.map((app) => app.slug)).toContain("personal-bots");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("only the owner's messages and task briefs name an app, not a bot's reply", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      // A reply that quotes a web page about Matchday is not what the chat is about.
      yield* addMessage(
        "a1",
        "assistant",
        "From the page: Matchday standings and Matchday fixtures",
        30,
      );
      yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      const turn = yield* context("ok thanks");
      expect(turn.block).not.toContain("Matchday dots show the name only.");
      expect(turn.trace?.activeApps).toEqual([]);
      // A task brief is a user-role message: it counts.
      yield* addMessage("personal-task-1", "user", "[Delegated task] Fix the Matchday dots", 20);
      const withBrief = yield* context("ok thanks");
      expect(withBrief.block).toContain("Matchday dots show the name only.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a scoped rule of another app is still found by search_memory", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      const memory = yield* PersonalMemoryService;
      const rule = yield* saveRule("Matchday dots show the name only.", ["matchday"]);
      const found = yield* memory.search({ query: "matchday dots", botId: BOT_A });
      expect(found.map((entry) => entry.memoryId)).toEqual([rule.memoryId]);
      expect(found[0]?.apps).toEqual(["matchday"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a note cannot be scoped: apps apply to rules only", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      const memory = yield* PersonalMemoryService;
      const note = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "A fact.",
        source: "user",
        apps: ["matchday"],
      });
      expect(note.apps).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("conversation-aware retrieval", () => {
  it.effect("a thin follow-up is searched by the chat's topic, not by 'works'", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots memory");
      yield* addMessage("m1", "user", "Can the memory retrieval in hbots read the chat title?", 90);
      yield* addMessage("m2", "assistant", "Yes, the hbots retrieval now reads the title.", 60);
      yield* saveNote("The Garmin band works with the Venu3 watch.");
      yield* saveNote("The tennis club court booking works on Thursdays.");
      yield* saveNote("hbots memory retrieval reads the chat title and recent turns.");
      for (let index = 0; index < 60; index++)
        yield* saveNote(`Filler fact ${index} about the garden.`);
      const turn = yield* context("This works thx");
      const block = turn.block ?? "";
      expect(block).toContain("hbots memory retrieval reads the chat title");
      expect(block).not.toContain("Garmin");
      expect(block).not.toContain("tennis club");
      expect(turn.trace?.query.followUp).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("kill switch: legacy retrieval searches the message alone, like before", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots memory");
      yield* saveNote("The Garmin band works with the Venu3 watch.");
      yield* saveNote("hbots memory retrieval reads the chat title and recent turns.");
      const turn = yield* context("This works thx");
      expect(turn.block).toContain("Garmin");
      expect(turn.block).not.toContain("hbots memory retrieval");
    }).pipe((effect) => withEnv(RETRIEVAL_ENV, "legacy", effect), Effect.provide(TestLayer)),
  );

  it.effect("an old status note ranks below newer and durable entries, and is named when cut", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      yield* saveNote("hbots 1.60.30 release armed and live, QA SHIP.", 45, "bot:cto;from=task");
      yield* saveNote("hbots release notes are written in HANDOFF files.", 45);
      yield* saveNote("hbots 1.60.38 release armed and live, QA SHIP.", 0, "bot:cto;from=task");
      const turn = yield* context("hbots release");
      const block = turn.block ?? "";
      // The newest status and the durable fact are given; the old status note is not,
      // and the trace says why (it stays in memory and in search_memory).
      expect(block).toContain("1.60.38");
      expect(block).toContain("HANDOFF files");
      expect(block).not.toContain("1.60.30");
      expect(block.indexOf("1.60.38")).toBeGreaterThan(-1);
      const cut = turn.trace?.leftOut.find((row) => row.reason.includes("older status entry"));
      expect(cut).toBeDefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an old status note is still given when it is the only match", () =>
    Effect.gen(function* () {
      yield* linkThread("hbots");
      yield* saveNote("hbots 1.60.30 release armed and live, QA SHIP.", 45, "bot:cto;from=task");
      const turn = yield* context("what was the hbots 1.60.30 release?");
      expect(turn.block).toContain("1.60.30");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("of one task title the newest summaries are given, not the best keyword matches", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      // Older runs repeat the question's words more, so they match best; the newest match least.
      for (let run = 1; run <= 5; run++) {
        const at = DateTime.formatIso(DateTime.subtract(now, { hours: 6 - run }));
        const words = "monitor results ".repeat(6 - run);
        yield* sql`
          INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version
          ) VALUES (
            ${`summary-run-${run}`}, 'bot', ${BOT_A}, 'task_summary',
            ${`Task "Racket monitor": run ${run} ${words}`}, ${`task:t${run}`}, 'normal',
            ${at}, ${at}, NULL, 1
          )
        `;
      }
      const turn = yield* context("show the monitor results from the racket monitor");
      const block = turn.block ?? "";
      expect(block).toContain("run 5 ");
      expect(block).toContain("run 4 ");
      expect(block).not.toContain("run 1 ");
      expect(block).not.toContain("run 2 ");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("caps the notes by count and by characters", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const long = "tomato ".repeat(95);
      for (let index = 0; index < 20; index++) {
        yield* saveNote(`Tomato bed ${index}: ${long}`);
      }
      const turn = yield* context("How are the tomato beds?");
      const lines = (turn.block ?? "").split("\n").filter((line) => line.startsWith("- [note]"));
      expect(lines.length).toBeLessThanOrEqual(PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT);
      const chars = lines.reduce((total, line) => total + line.length, 0);
      expect(chars).toBeLessThanOrEqual(RELEVANT_MAX_CHARS);
      expect(turn.trace?.leftOut.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("rules cap warning", () => {
  it.effect("is ok well under the caps", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      yield* saveRule("Short rule.");
      const memory = yield* PersonalMemoryService;
      const usage = yield* memory.rulesUsage();
      expect(usage.level).toBe("ok");
      expect(usage.rows[0]?.entries).toBe(1);
      expect(usage.maxEntries).toBe(PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("warns at 80% of the most rules a bot receives, counting every app", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      // 49 of 60 rules, split between global and two apps.
      for (let index = 0; index < 19; index++) yield* saveRule(`Global ${index}.`);
      for (let index = 0; index < 15; index++) yield* saveRule(`Matchday ${index}.`, ["matchday"]);
      for (let index = 0; index < 15; index++)
        yield* saveRule(`hbots ${index}.`, ["personal-bots"]);
      const memory = yield* PersonalMemoryService;
      const usage = yield* memory.rulesUsage();
      expect(usage.level).toBe("near");
      expect(usage.rows[0]).toMatchObject({ entries: 49, globalRules: 19, appRules: 30 });
      expect(usage.rows[0]!.share).toBeCloseTo(49 / 60, 5);
      expect(usage.rows[0]!.leftOut).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports exactly which app rules would not fit once the caps are passed", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const big = "z".repeat(1_900);
      yield* saveRule("Global short.");
      const left: Array<string> = [];
      for (let index = 0; index < 9; index++) {
        const rule = yield* saveRule(`Matchday ${index} ${big}`, ["matchday"]);
        // Newest first: the oldest ones are the ones that do not fit.
        if (index < 2) left.push(rule.memoryId);
      }
      const memory = yield* PersonalMemoryService;
      const usage = yield* memory.rulesUsage();
      expect(usage.level).toBe("over");
      expect(usage.rows[0]!.leftOut.map((rule) => rule.memoryId).toSorted()).toEqual(
        left.toSorted(),
      );
      expect(usage.rows[0]!.chars).toBeGreaterThan(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Context used: what a turn was given, and the owner's marks (1.60.41)", () => {
  const recorded = (
    query: string,
    messageId: string,
    session?: { readonly key: string; readonly fresh: boolean },
  ) =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      return yield* memory.contextForThread({
        threadId: THREAD_A,
        query,
        record: true,
        messageId,
        ...(session === undefined ? {} : { session }),
      });
    });

  it.effect(
    "a recorded turn can be read back: apps, rules, notes with why, and what was left out",
    () =>
      Effect.gen(function* () {
        yield* linkThread("matchday");
        const memory = yield* PersonalMemoryService;
        yield* saveRule("Always answer in plain words.");
        const dots = yield* saveRule("Matchday dots show the name only.", ["matchday"]);
        yield* saveRule("hbots Back goes to the Bots page.", ["personal-bots"]);
        const note = yield* saveNote("Matchday dots were redesigned on 2026-10-01.");
        yield* recorded("What about the dots?", "msg-1");

        const view = yield* memory.turnContext({ threadId: THREAD_A, messageId: "msg-1" });
        expect(view).not.toBeNull();
        expect(view!.apps).toEqual([{ slug: "matchday", label: "Matchday", via: ["title"] }]);
        expect(view!.rules.sent).toBe(true);
        expect(view!.rules.items.map((rule) => rule.content).toSorted()).toEqual([
          "Always answer in plain words.",
          "Matchday dots show the name only.",
        ]);
        expect(view!.rules.items.find((rule) => rule.memoryId === dots.memoryId)?.apps).toEqual([
          "matchday",
        ]);
        expect(view!.rules.index).toBe("hbots: 1 rule");
        expect(view!.notes.map((entry) => entry.memoryId)).toEqual([note.memoryId]);
        expect(view!.notes[0]).toMatchObject({ kind: "note", feedback: null, current: true });
        // Whatever was cut says why, in words the owner can read.
        for (const cut of view!.leftOut)
          expect(cut.reason).toContain("matched much less than the best");
        expect(view!.notes[0]!.snippet).toContain("Matchday dots were redesigned");
        expect(view!.query.terms.length).toBeGreaterThan(0);
        // A message that started no recorded turn has nothing.
        expect(yield* memory.turnContext({ threadId: THREAD_A, messageId: "msg-none" })).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a reminder turn says the rules listed earlier still applied, and a newly covered app's rules are 'added'",
    () =>
      Effect.gen(function* () {
        yield* linkThread("Chat");
        const memory = yield* PersonalMemoryService;
        yield* saveRule("Always answer in plain words.");
        const matchday = yield* saveRule("Matchday dots show the name only.", ["matchday"]);
        const session = { key: "claude:1", fresh: true };
        yield* recorded("Look at the Matchday page", "t1", session);
        yield* memory.confirmPreferencesSent(THREAD_A);
        const second = yield* recorded("and again", "t2", { ...session, fresh: false });
        yield* memory.confirmPreferencesSent(THREAD_A);
        const view = yield* memory.turnContext({ threadId: THREAD_A, messageId: "t2" });
        // Nothing was sent again, yet the rules are still shown as what applied.
        expect(second.memoryIds).toEqual([]);
        expect(view!.rules.sent).toBe(false);
        expect(view!.rules.items.map((rule) => rule.memoryId)).toContain(matchday.memoryId);

        const caltrack = yield* saveRule("CalTrack keeps the weight form value.", ["caltrack"]);
        yield* recorded("Now the CalTrack form", "t3", { ...session, fresh: false });
        const third = yield* memory.turnContext({ threadId: THREAD_A, messageId: "t3" });
        expect(third!.rules.added).toEqual([caltrack.memoryId]);
        expect(third!.apps.map((app) => app.slug).toSorted()).toEqual(["caltrack", "matchday"]);
        expect(third!.apps.find((app) => app.slug === "matchday")?.via).toEqual(["earlier"]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a rule replaced since the turn is shown as no longer current", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const memory = yield* PersonalMemoryService;
      const old = yield* saveRule("Quote prices in USD.");
      yield* recorded("hello", "m-rule");
      yield* memory.forget({ memoryId: old.memoryId, actorBotId: BOT_A });
      const view = yield* memory.turnContext({ threadId: THREAD_A, messageId: "m-rule" });
      expect(view!.rules.items).toMatchObject([
        { memoryId: old.memoryId, content: "Quote prices in USD.", apps: null, current: false },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "outdated and not relevant rank an entry lower in later turns, never delete it, and can be cleared",
    () =>
      Effect.gen(function* () {
        yield* linkThread("Chat");
        const memory = yield* PersonalMemoryService;
        const stale = yield* saveNote("The garden shed key is under the blue pot.");
        yield* saveNote("The garden shed was repainted green in spring.");
        yield* saveNote("The garden shed roof leaks near the north corner.");

        const before = yield* context("Where is the garden shed key?");
        expect(before.block).toContain("under the blue pot");
        const firstScore = before.trace!.picked.find(
          (row) => row.memoryId === stale.memoryId,
        )!.score;

        const marked = yield* memory.setFeedback({ memoryId: stale.memoryId, signal: "outdated" });
        expect(marked).toEqual({ memoryId: stale.memoryId, signal: "outdated" });
        expect((yield* memory.get(stale.memoryId)).demoted).toBe("outdated");
        const after = yield* context("Where is the garden shed key?");
        const row = after.trace!.picked.find((entry) => entry.memoryId === stale.memoryId);
        // Ranked far lower (and named as marked), but still searchable and not deleted.
        expect(row === undefined || row.score < firstScore * 0.2).toBe(true);
        if (row !== undefined) expect(row.why).toContain("you marked it outdated");
        expect((yield* memory.list({})).map((entry) => entry.memoryId)).toContain(stale.memoryId);
        expect(
          (yield* memory.search({ query: "garden shed key", botId: BOT_A })).map(
            (entry) => entry.memoryId,
          ),
        ).toContain(stale.memoryId);

        // Not relevant is lighter; marking again replaces the mark.
        yield* memory.setFeedback({ memoryId: stale.memoryId, signal: "not_relevant" });
        expect((yield* memory.get(stale.memoryId)).demoted).toBe("not_relevant");
        // Cleared: it ranks as before.
        yield* memory.setFeedback({ memoryId: stale.memoryId, signal: "clear" });
        expect((yield* memory.get(stale.memoryId)).demoted).toBeNull();
        const restored = yield* context("Where is the garden shed key?");
        expect(
          restored.trace!.picked.find((entry) => entry.memoryId === stale.memoryId)!.score,
        ).toBe(firstScore);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "an entry's mark goes when it is forgotten, removed or superseded, and a restored entry starts clean",
    () =>
      Effect.gen(function* () {
        yield* linkThread("Chat");
        const memory = yield* PersonalMemoryService;
        const sql = yield* SqlClient.SqlClient;
        const marks = () =>
          sql<{ readonly memoryId: string }>`
            SELECT memory_id AS "memoryId" FROM personal_memory_feedback ORDER BY memory_id
          `.pipe(Effect.map((rows) => rows.map((row) => row.memoryId)));

        const forgotten = yield* saveNote("The old gate code note.");
        const removed = yield* saveNote("The old alarm note.");
        const hardDeleted = yield* saveNote("The old router note.");
        const kept = yield* saveNote("The kitchen note.");
        for (const entry of [forgotten, removed, hardDeleted, kept]) {
          yield* memory.setFeedback({ memoryId: entry.memoryId, signal: "outdated" });
        }
        expect(yield* marks()).toHaveLength(4);

        // Forgetting (a supersede with no successor) takes its mark; restoring does not bring it back.
        yield* memory.forget({ memoryId: forgotten.memoryId, actorBotId: BOT_A });
        expect(yield* marks()).not.toContain(forgotten.memoryId);
        yield* memory.restore({ memoryId: forgotten.memoryId });
        expect((yield* memory.get(forgotten.memoryId)).demoted).toBeNull();

        // A soft delete and a hard delete do too.
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE personal_memory SET deleted_at = ${now} WHERE memory_id = ${removed.memoryId}`;
        expect(yield* marks()).not.toContain(removed.memoryId);
        yield* sql`DELETE FROM personal_memory WHERE memory_id = ${hardDeleted.memoryId}`;
        expect(yield* marks()).toEqual([kept.memoryId]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a rule cannot be marked: rules change only through an approval", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const memory = yield* PersonalMemoryService;
      const rule = yield* saveRule("Quote prices in USD.");
      const refused = yield* Effect.flip(
        memory.setFeedback({ memoryId: rule.memoryId, signal: "outdated" }),
      );
      expect(refused.message).toContain("cannot be marked");
      expect((yield* memory.get(rule.memoryId)).demoted).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("traces older than 14 days are cleared, the usage rows stay", () =>
    Effect.gen(function* () {
      yield* linkThread("Chat");
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtract(now, { days: 20 }));
      yield* sql`
        INSERT INTO personal_memory_usage
          (thread_id, task_id, attempt, memory_ids_json, created_at, message_id, trace_json)
        VALUES (${THREAD_A}, NULL, NULL, '[]', ${old}, 'm-old', '{"x":1}')
      `;
      yield* saveRule("A rule.");
      yield* recorded("hello", "m-new");
      const rows = yield* sql<{ readonly messageId: string; readonly kept: number }>`
        SELECT message_id AS "messageId", trace_json IS NOT NULL AS "kept"
        FROM personal_memory_usage ORDER BY usage_id
      `;
      expect(rows).toEqual([
        { messageId: "m-old", kept: 0 },
        { messageId: "m-new", kept: 1 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "the newest matches join the candidates, so a recent summary is not lost behind forty old ones",
    () =>
      Effect.gen(function* () {
        yield* linkThread("Chat");
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const insert = (id: string, title: string, body: string, daysOld: number) => {
          const at = DateTime.formatIso(DateTime.subtract(now, { days: daysOld }));
          return sql`
          INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version
          ) VALUES (${id}, 'bot', ${BOT_A}, 'task_summary', ${`Task "${title}": ${body}`},
            ${`task:${id}`}, 'normal', ${at}, ${at}, NULL, 1)
        `;
        };
        // Forty old summaries repeat the question's words, so they match best.
        for (let index = 0; index < 40; index++) {
          yield* insert(
            `old-${index}`,
            `Old job ${index}`,
            "rollout status rollout status rollout status",
            40,
          );
        }
        yield* insert("recent", "Fresh job", "rollout finished today", 0);
        const turn = yield* context("what is the rollout status");
        expect(turn.block).toContain("rollout finished today");
      }).pipe(Effect.provide(TestLayer)),
  );
});
