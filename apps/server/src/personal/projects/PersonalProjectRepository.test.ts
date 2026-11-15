import { PersonalBotId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PersonalProjectRepository from "./PersonalProjectRepository.ts";

const LEAD = PersonalBotId.make("bot-poteto");
const OTHER_LEAD = PersonalBotId.make("bot-cto");
const STEPS = [
  { label: "Build", state: "done" as const },
  { label: "Verify on emulator", state: "doing" as const },
];

const layer = PersonalProjectRepository.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly name: string; readonly state: string }>`
    SELECT name, state FROM personal_projects ORDER BY created_at, name
  `;
});

describe("PersonalProjectRepository.update", () => {
  it.effect("a second call with the same name, in any case, updates the one row", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      const first = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Matchday optimisation",
        steps: STEPS,
      });
      const second = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "matchday OPTIMISATION",
        steps: [
          { label: "Build", state: "done" },
          { label: "Verify on emulator", state: "done" },
        ],
      });
      expect(second.projectId).toBe(first.projectId);
      expect(second.name).toBe("Matchday optimisation");
      expect(second.steps.map((step) => step.state)).toEqual(["done", "done"]);
      expect(yield* projectRows).toEqual([{ name: "Matchday optimisation", state: "open" }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("two leads keep projects of the same name apart", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      const mine = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: STEPS,
      });
      const theirs = yield* projects.update({
        leadBotId: OTHER_LEAD,
        threadId: null,
        name: "Kino",
        steps: STEPS,
      });
      expect(theirs.projectId).not.toBe(mine.projectId);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses 9 steps, a create without steps and a close of nothing", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      const nine = Array.from({ length: 9 }, (_, index) => ({
        label: `Step ${index + 1}`,
        state: "todo" as const,
      }));
      const tooMany = yield* Effect.flip(
        projects.update({ leadBotId: LEAD, threadId: null, name: "Big", steps: nine }),
      );
      const noSteps = yield* Effect.flip(
        projects.update({ leadBotId: LEAD, threadId: null, name: "Bare" }),
      );
      const closeNothing = yield* Effect.flip(
        projects.update({ leadBotId: LEAD, threadId: null, name: "Ghost", close: "done" }),
      );
      expect(tooMany.message).toBe("Give 1 to 8 steps.");
      expect(noSteps.message).toBe('Give steps to create the project "Bare".');
      expect(closeNothing.message).toBe(
        'No open project is named "Ghost". You have no open projects.',
      );
      expect(yield* projectRows).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("minutesLeft 90 sets dueAt 90 minutes after the call; null clears; absent keeps", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* TestClock.adjust("1 hour");
      const callAt = DateTime.toEpochMillis(yield* DateTime.now);
      const estimated = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "CalTrack Android port",
        steps: STEPS,
        minutesLeft: 90,
      });
      expect(estimated.estimate).not.toBeNull();
      expect(DateTime.toEpochMillis(estimated.estimate!.dueAt)).toBe(callAt + 90 * 60_000);
      expect(DateTime.toEpochMillis(estimated.estimate!.estimatedAt)).toBe(callAt);

      yield* TestClock.adjust("10 minutes");
      const kept = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "CalTrack Android port",
      });
      expect(kept.estimate).toEqual(estimated.estimate);

      const cleared = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "CalTrack Android port",
        minutesLeft: null,
      });
      expect(cleared.estimate).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("close done sets closedAt, keeps it listed 30 days, and frees the name", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* TestClock.adjust("1 day");
      const opened = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "hbots changes",
        steps: STEPS,
      });
      const closeAt = DateTime.toEpochMillis(yield* DateTime.now);
      const closed = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "hbots changes",
        close: "done",
      });
      expect(closed.state.kind).toBe("done");
      expect(closed.state.kind === "done" && DateTime.toEpochMillis(closed.state.closedAt)).toBe(
        closeAt,
      );

      const reopened = yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "hbots changes",
        steps: STEPS,
      });
      expect(reopened.projectId).not.toBe(opened.projectId);
      expect((yield* projects.list()).map((project) => project.state.kind).toSorted()).toEqual([
        "done",
        "open",
      ]);

      yield* TestClock.adjust("31 days");
      expect((yield* projects.list()).map((project) => project.projectId)).toEqual([
        reopened.projectId,
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removeForLead deletes that lead's projects only", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* projects.update({ leadBotId: LEAD, threadId: null, name: "Mine", steps: STEPS });
      yield* projects.update({
        leadBotId: OTHER_LEAD,
        threadId: null,
        name: "Theirs",
        steps: STEPS,
      });
      yield* projects.removeForLead(LEAD);
      expect(yield* projectRows).toEqual([{ name: "Theirs", state: "open" }]);
    }).pipe(Effect.provide(layer)),
  );
});
