import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

const thread = (id: string) => ThreadId.make(id);

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

describe("PersonalProjectRepository history", () => {
  const historyOf = Effect.gen(function* () {
    const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
    const open = yield* projects.findOpen({ leadBotId: LEAD, name: "Kino" });
    if (open === null) return [];
    return yield* projects.history(open.projectId);
  });

  it.effect("a step change adds one entry per moved step and a repeat adds nothing", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "doing" },
          { label: "Verify", state: "todo" },
        ],
      });
      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "done" },
          { label: "Verify", state: "doing" },
        ],
      });
      const moved = yield* historyOf;
      expect(
        moved.map((entry) => (entry.kind === "step" ? [entry.label, entry.state] : entry.kind)),
      ).toEqual([
        ["Build", "done"],
        ["Verify", "doing"],
      ]);

      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "done" },
          { label: "Verify", state: "doing" },
        ],
      });
      expect(yield* historyOf).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("changed labels add one replanned entry with the new step count", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "doing" },
          { label: "Verify", state: "todo" },
        ],
      });
      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "doing" },
          { label: "Ship", state: "todo" },
          { label: "Close out", state: "todo" },
        ],
      });
      const history = yield* historyOf;
      expect(history).toHaveLength(1);
      expect(history[0]?.kind).toBe("replanned");
      expect(history[0]?.kind === "replanned" ? history[0].steps : 0).toBe(3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("45 single-step changes keep the newest 40 entries", () =>
    Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      yield* projects.update({
        leadBotId: LEAD,
        threadId: null,
        name: "Kino",
        steps: [
          { label: "Build", state: "todo" },
          { label: "Verify", state: "todo" },
        ],
      });
      yield* Effect.forEach(
        Array.from({ length: 45 }, (_, index) => index),
        (index) =>
          projects.update({
            leadBotId: LEAD,
            threadId: null,
            name: "Kino",
            steps: [
              { label: "Build", state: index % 2 === 0 ? "done" : "todo" },
              { label: "Verify", state: "todo" },
            ],
          }),
        { discard: true },
      );
      expect(yield* historyOf).toHaveLength(40);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "why is stored, kept by a later call without it, and cleared by an empty string",
    () => {
      const why = "Harout can't keep up across chats";
      return Effect.gen(function* () {
        const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
        const created = yield* projects.update({
          leadBotId: LEAD,
          threadId: null,
          name: "Kino",
          steps: STEPS,
          why,
        });
        expect(created.why).toBe(why);

        const kept = yield* projects.update({
          leadBotId: LEAD,
          threadId: null,
          name: "Kino",
        });
        expect(kept.why).toBe(why);

        const cleared = yield* projects.update({
          leadBotId: LEAD,
          threadId: null,
          name: "Kino",
          why: "",
        });
        expect(cleared.why).toBeNull();

        const tooLong = yield* Effect.flip(
          projects.update({
            leadBotId: LEAD,
            threadId: null,
            name: "Kino",
            why: "x".repeat(141),
          }),
        );
        expect(tooLong.message).toBe("Keep why to 140 characters.");
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("PersonalProjectRepository.list", () => {
  it.effect("gives each goal its chats: its own chat first, then the newest, 10 at most", () => {
    const insertTask = (input: {
      readonly taskId: string;
      readonly projectId: string;
      readonly threadId: string;
      readonly updatedAt: string;
    }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
            INSERT INTO personal_tasks (
              task_id, root_task_id, bot_id, thread_id, title, objective, status, source,
              idempotency_key, depth, max_depth, max_children, project_id, created_at, updated_at
            )
            VALUES (
              ${input.taskId}, ${input.taskId}, 'bot-builder', ${input.threadId}, 'Task', 'Do it.',
              'running', 'delegation', ${input.taskId}, 1, 3, 5, ${input.projectId},
              '2026-11-15T08:00:00.000Z', ${input.updatedAt}
            )
          `;
      });
    return Effect.gen(function* () {
      const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
      const busy = yield* projects.update({
        leadBotId: LEAD,
        threadId: thread("thread-lead"),
        name: "Busy goal",
        steps: STEPS,
      });
      const quiet = yield* projects.update({
        leadBotId: LEAD,
        threadId: thread("thread-quiet"),
        name: "Quiet goal",
        steps: STEPS,
      });
      const detached = yield* projects.update({
        leadBotId: OTHER_LEAD,
        threadId: null,
        name: "No lead chat",
        steps: STEPS,
      });
      for (let index = 1; index <= 12; index += 1) {
        const minute = String(index).padStart(2, "0");
        yield* insertTask({
          taskId: `task-${minute}`,
          projectId: busy.projectId,
          threadId: `thread-${minute}`,
          updatedAt: `2026-11-15T10:${minute}:00.000Z`,
        });
      }
      // The lead's own chat also carries a task: it still comes first, once.
      yield* insertTask({
        taskId: "task-lead",
        projectId: busy.projectId,
        threadId: "thread-lead",
        updatedAt: "2026-11-15T09:00:00.000Z",
      });
      yield* insertTask({
        taskId: "task-detached",
        projectId: detached.projectId,
        threadId: "thread-helper",
        updatedAt: "2026-11-15T10:30:00.000Z",
      });

      const listed = yield* projects.list();
      const chatsOf = (projectId: string) =>
        listed.find((entry) => entry.projectId === projectId)?.chats;

      expect(chatsOf(busy.projectId)).toEqual([
        "thread-lead",
        "thread-12",
        "thread-11",
        "thread-10",
        "thread-09",
        "thread-08",
        "thread-07",
        "thread-06",
        "thread-05",
        "thread-04",
      ]);
      expect(chatsOf(quiet.projectId)).toEqual(["thread-quiet"]);
      expect(chatsOf(detached.projectId)).toEqual(["thread-helper"]);
    }).pipe(Effect.provide(layer));
  });
});
