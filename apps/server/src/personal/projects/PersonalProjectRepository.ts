import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersonalBotId,
  PersonalProjectId,
  PersonalProjectStep,
  PersonalTasksError,
  ThreadId,
  type PersonalProject,
  type PersonalProjectState,
} from "@t3tools/contracts";

export const PROJECT_NAME_MAX = 48;
export const PROJECT_STEP_LABEL_MAX = 40;
export const PROJECT_STEPS_MAX = 8;
export const PROJECT_MINUTES_LEFT_MAX = 10_080;
export const PROJECT_CLOSED_LIST_DAYS = 30;

export type PersonalProjectClose = "done" | "dropped";

export interface PersonalProjectUpdateInput {
  readonly leadBotId: PersonalBotId;
  readonly threadId: ThreadId | null;
  readonly name: string;
  readonly steps?: ReadonlyArray<PersonalProjectStep>;
  /** Minutes from now; null clears the estimate; absent keeps it. */
  readonly minutesLeft?: number | null;
  readonly close?: PersonalProjectClose;
}

const ProjectDbRow = Schema.Struct({
  projectId: PersonalProjectId,
  leadBotId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  name: Schema.String,
  steps: Schema.fromJsonString(Schema.NonEmptyArray(PersonalProjectStep)),
  dueAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  estimatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  state: Schema.Literals(["open", "done", "dropped"]),
  closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastActivityAt: Schema.DateTimeUtcFromString,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeRow = Schema.decodeUnknownEffect(ProjectDbRow);

const PROJECT_COLUMNS = `
  p.project_id AS "projectId",
  p.lead_bot_id AS "leadBotId",
  p.thread_id AS "threadId",
  p.name AS "name",
  p.steps_json AS "steps",
  p.due_at AS "dueAt",
  p.estimated_at AS "estimatedAt",
  p.state AS "state",
  p.closed_at AS "closedAt",
  MAX(
    p.updated_at,
    COALESCE(
      (SELECT MAX(t.updated_at) FROM personal_tasks t WHERE t.project_id = p.project_id),
      p.updated_at
    )
  ) AS "lastActivityAt",
  p.created_at AS "createdAt",
  p.updated_at AS "updatedAt"
`;

const toProject = (row: typeof ProjectDbRow.Type): PersonalProject => {
  const state: PersonalProjectState =
    row.state === "open" || row.closedAt === null
      ? { kind: "open" }
      : { kind: row.state, closedAt: row.closedAt };
  return {
    projectId: row.projectId,
    leadBotId: row.leadBotId,
    threadId: row.threadId,
    name: row.name,
    steps: row.steps,
    estimate:
      row.dueAt === null || row.estimatedAt === null
        ? null
        : { dueAt: row.dueAt, estimatedAt: row.estimatedAt },
    state,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const fail = (message: string) => new PersonalTasksError({ message });

/** Why the input cannot be stored, or null. Checked before any write. */
export const projectInputProblem = (input: PersonalProjectUpdateInput): string | null => {
  const name = input.name.trim();
  if (name.length === 0) return "Give the project a name.";
  if (name.length > PROJECT_NAME_MAX) {
    return `Keep the project name to ${PROJECT_NAME_MAX} characters.`;
  }
  if (input.steps !== undefined) {
    if (input.steps.length === 0 || input.steps.length > PROJECT_STEPS_MAX) {
      return `Give 1 to ${PROJECT_STEPS_MAX} steps.`;
    }
    const long = input.steps.find((step) => step.label.trim().length > PROJECT_STEP_LABEL_MAX);
    if (long !== undefined) {
      return `Keep each step label to ${PROJECT_STEP_LABEL_MAX} characters: "${long.label}".`;
    }
  }
  if (
    input.minutesLeft !== undefined &&
    input.minutesLeft !== null &&
    (!Number.isInteger(input.minutesLeft) ||
      input.minutesLeft < 1 ||
      input.minutesLeft > PROJECT_MINUTES_LEFT_MAX)
  ) {
    return `minutesLeft is a whole number from 1 to ${PROJECT_MINUTES_LEFT_MAX}, or null to clear it.`;
  }
  return null;
};

export class PersonalProjectRepository extends Context.Service<
  PersonalProjectRepository,
  {
    /**
     * Finds the lead's open project by name, case-insensitively, and updates
     * it, or creates it when none is open. A repeated call converges on one row.
     */
    readonly update: (
      input: PersonalProjectUpdateInput,
    ) => Effect.Effect<PersonalProject, PersonalTasksError>;
    readonly get: (
      projectId: PersonalProjectId,
    ) => Effect.Effect<PersonalProject | null, PersonalTasksError>;
    readonly findOpen: (input: {
      readonly leadBotId: PersonalBotId;
      readonly name: string;
    }) => Effect.Effect<PersonalProject | null, PersonalTasksError>;
    /** The lead's open projects, most recent activity first. */
    readonly listOpenForLead: (
      leadBotId: PersonalBotId,
    ) => Effect.Effect<ReadonlyArray<PersonalProject>, PersonalTasksError>;
    /** Every open project, plus those closed in the last 30 days. */
    readonly list: () => Effect.Effect<ReadonlyArray<PersonalProject>, PersonalTasksError>;
    readonly removeForLead: (leadBotId: PersonalBotId) => Effect.Effect<void, PersonalTasksError>;
  }
>()("t3/personal/projects/PersonalProjectRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFailure = (operation: string) => (cause: unknown) =>
    new PersonalTasksError({ message: `Could not ${operation} projects; try again.`, cause });

  const decodeAll = (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(
        Effect.map(toProject),
        Effect.mapError(
          (cause) => new PersonalTasksError({ message: "A project row is invalid.", cause }),
        ),
      ),
    );

  const selectOpen = (leadBotId: PersonalBotId, name: string) =>
    sql`
      SELECT ${sql.literal(PROJECT_COLUMNS)} FROM personal_projects p
      WHERE p.lead_bot_id = ${leadBotId} AND p.state = 'open' AND lower(p.name) = lower(${name})
    `.pipe(Effect.mapError(sqlFailure("read")), Effect.flatMap(decodeAll));

  const selectById = (projectId: PersonalProjectId) =>
    sql`
      SELECT ${sql.literal(PROJECT_COLUMNS)} FROM personal_projects p
      WHERE p.project_id = ${projectId}
    `.pipe(Effect.mapError(sqlFailure("read")), Effect.flatMap(decodeAll));

  const listOpenForLead: PersonalProjectRepository["Service"]["listOpenForLead"] = (leadBotId) =>
    sql`
      SELECT ${sql.literal(PROJECT_COLUMNS)} FROM personal_projects p
      WHERE p.lead_bot_id = ${leadBotId} AND p.state = 'open'
      ORDER BY "lastActivityAt" DESC, p.created_at DESC
    `.pipe(Effect.mapError(sqlFailure("read")), Effect.flatMap(decodeAll));

  const get: PersonalProjectRepository["Service"]["get"] = (projectId) =>
    selectById(projectId).pipe(Effect.map((rows) => rows[0] ?? null));

  const findOpen: PersonalProjectRepository["Service"]["findOpen"] = (input) =>
    selectOpen(input.leadBotId, input.name.trim()).pipe(Effect.map((rows) => rows[0] ?? null));

  const openNames = (leadBotId: PersonalBotId) =>
    listOpenForLead(leadBotId).pipe(
      Effect.map((projects) =>
        projects.length === 0
          ? "You have no open projects."
          : `Open projects: ${projects.map((project) => project.name).join(", ")}.`,
      ),
    );

  const update: PersonalProjectRepository["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const problem = projectInputProblem(input);
      if (problem !== null) return yield* fail(problem);
      const name = input.name.trim();
      const steps = input.steps?.map((step) => ({ label: step.label.trim(), state: step.state }));
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);
      const estimate =
        input.minutesLeft === undefined
          ? undefined
          : input.minutesLeft === null
            ? { dueAt: null, estimatedAt: null }
            : {
                dueAt: DateTime.formatIso(DateTime.add(now, { minutes: input.minutesLeft })),
                estimatedAt: at,
              };
      const projectId = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = (yield* selectOpen(input.leadBotId, name))[0];
            if (existing === undefined) {
              if (input.close !== undefined) {
                return yield* fail(
                  `No open project is named "${name}". ${yield* openNames(input.leadBotId)}`,
                );
              }
              if (steps === undefined) {
                return yield* fail(`Give steps to create the project "${name}".`);
              }
              const created = PersonalProjectId.make(NodeCrypto.randomUUID());
              yield* sql`
                INSERT INTO personal_projects (
                  project_id, lead_bot_id, thread_id, name, steps_json, due_at, estimated_at,
                  state, closed_at, created_at, updated_at
                )
                VALUES (
                  ${created}, ${input.leadBotId}, ${input.threadId}, ${name},
                  ${JSON.stringify(steps)}, ${estimate?.dueAt ?? null},
                  ${estimate?.estimatedAt ?? null}, 'open', NULL, ${at}, ${at}
                )
              `.pipe(Effect.mapError(sqlFailure("save")));
              return created;
            }
            yield* sql`
              UPDATE personal_projects
              SET thread_id = COALESCE(${input.threadId}, thread_id),
                  steps_json = ${steps === undefined ? sql`steps_json` : JSON.stringify(steps)},
                  due_at = ${estimate === undefined ? sql`due_at` : estimate.dueAt},
                  estimated_at = ${estimate === undefined ? sql`estimated_at` : estimate.estimatedAt},
                  state = ${input.close ?? "open"},
                  closed_at = ${input.close === undefined ? null : at},
                  updated_at = ${at}
              WHERE project_id = ${existing.projectId}
            `.pipe(Effect.mapError(sqlFailure("save")));
            return existing.projectId;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PersonalTasksError" ? error : sqlFailure("save")(error),
          ),
        );
      const stored = (yield* selectById(projectId))[0];
      if (stored === undefined) return yield* fail("The project could not be read after saving.");
      return stored;
    });

  const list: PersonalProjectRepository["Service"]["list"] = () =>
    Effect.gen(function* () {
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: PROJECT_CLOSED_LIST_DAYS }),
      );
      return yield* sql`
        SELECT ${sql.literal(PROJECT_COLUMNS)} FROM personal_projects p
        WHERE p.state = 'open' OR p.closed_at >= ${since}
        ORDER BY "lastActivityAt" DESC, p.created_at DESC
      `.pipe(Effect.mapError(sqlFailure("read")), Effect.flatMap(decodeAll));
    });

  const removeForLead: PersonalProjectRepository["Service"]["removeForLead"] = (leadBotId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE personal_tasks SET project_id = NULL
            WHERE project_id IN (
              SELECT project_id FROM personal_projects WHERE lead_bot_id = ${leadBotId}
            )
          `;
          yield* sql`DELETE FROM personal_projects WHERE lead_bot_id = ${leadBotId}`;
        }),
      )
      .pipe(Effect.mapError(sqlFailure("remove")));

  return {
    update,
    get,
    findOpen,
    listOpenForLead,
    list,
    removeForLead,
  } satisfies PersonalProjectRepository["Service"];
});

export const layer = Layer.effect(PersonalProjectRepository, make);
