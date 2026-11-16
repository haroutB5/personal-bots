import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PERSONAL_PROJECT_CHATS_MAX,
  PERSONAL_PROJECT_WHY_MAX,
  PersonalBotId,
  PersonalProjectId,
  PersonalProjectHistoryEntry,
  PersonalProjectStep,
  PersonalTasksError,
  ThreadId,
  type PersonalProject,
  type PersonalProjectState,
} from "@t3tools/contracts";

export const PROJECT_NAME_MAX = 48;
export const PROJECT_STEP_LABEL_MAX = 40;
export const PROJECT_STEPS_MAX = 8;
export const PROJECT_WHY_MAX = PERSONAL_PROJECT_WHY_MAX;
export const PROJECT_HISTORY_MAX = 40;
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
  /** One plain line on why the goal matters; null or "" clears it; absent keeps it. */
  readonly why?: string | null;
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
  why: Schema.NullOr(Schema.String),
  history: Schema.fromJsonString(Schema.Array(PersonalProjectHistoryEntry)),
});
const decodeRow = Schema.decodeUnknownEffect(ProjectDbRow);

interface ProjectRecord {
  readonly project: PersonalProject;
  readonly history: ReadonlyArray<PersonalProjectHistoryEntry>;
}

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
  p.updated_at AS "updatedAt",
  p.why AS "why",
  p.history_json AS "history"
`;

const toRecord = (row: typeof ProjectDbRow.Type): ProjectRecord => {
  const state: PersonalProjectState =
    row.state === "open" || row.closedAt === null
      ? { kind: "open" }
      : { kind: row.state, closedAt: row.closedAt };
  return {
    project: {
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
      why: row.why,
    },
    history: row.history,
  };
};

/**
 * The chats a goal tags: its own chat first, then the ones whose tasks moved
 * most recently, at most PERSONAL_PROJECT_CHATS_MAX.
 */
const chatListOf = (
  ownThreadId: ThreadId | null,
  rows: ReadonlyArray<{ readonly threadId: string; readonly at: string }>,
): ReadonlyArray<ThreadId> => {
  const seen = new Set<string>();
  const chats: Array<ThreadId> = [];
  const add = (threadId: string | null) => {
    if (threadId === null || seen.has(threadId)) return;
    if (chats.length >= PERSONAL_PROJECT_CHATS_MAX) return;
    seen.add(threadId);
    chats.push(ThreadId.make(threadId));
  };
  add(ownThreadId);
  const newestFirst = rows.toSorted(
    (left, right) => right.at.localeCompare(left.at) || left.threadId.localeCompare(right.threadId),
  );
  for (const row of newestFirst) add(row.threadId);
  return chats;
};

/**
 * What to append for one update: nothing when the steps are unchanged, one
 * entry per moved step, or a replan when the labels changed. Newest first.
 */
const historyAfterUpdate = (
  history: ReadonlyArray<PersonalProjectHistoryEntry>,
  before: ReadonlyArray<PersonalProjectStep>,
  after: ReadonlyArray<PersonalProjectStep> | undefined,
  at: string,
): ReadonlyArray<PersonalProjectHistoryEntry> => {
  if (after === undefined) return history;
  const sameLabels =
    before.length === after.length &&
    before.every((step, index) => step.label === after[index]?.label);
  if (!sameLabels) {
    const replanned: PersonalProjectHistoryEntry = {
      kind: "replanned",
      at: DateTime.makeUnsafe(at),
      steps: after.length,
    };
    return [replanned, ...history].slice(0, PROJECT_HISTORY_MAX);
  }
  const moved = after.flatMap((step, index) => {
    const previous = before[index];
    return previous !== undefined && previous.state !== step.state
      ? [
          {
            kind: "step" as const,
            at: DateTime.makeUnsafe(at),
            label: step.label,
            state: step.state,
          },
        ]
      : [];
  });
  return [...moved, ...history].slice(0, PROJECT_HISTORY_MAX);
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
  if (input.why !== undefined && input.why !== null && input.why.trim().length > PROJECT_WHY_MAX) {
    return `Keep why to ${PROJECT_WHY_MAX} characters.`;
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
    /** One project's recorded plan changes, newest first. Empty when it is missing. */
    readonly history: (
      projectId: PersonalProjectId,
    ) => Effect.Effect<ReadonlyArray<PersonalProjectHistoryEntry>, PersonalTasksError>;
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
        Effect.map(toRecord),
        Effect.mapError(
          (cause) => new PersonalTasksError({ message: "A project row is invalid.", cause }),
        ),
      ),
    );

  const projectsOf = (records: ReadonlyArray<ProjectRecord>) =>
    records.map((record) => record.project);

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
    `.pipe(Effect.mapError(sqlFailure("read")), Effect.flatMap(decodeAll), Effect.map(projectsOf));

  const get: PersonalProjectRepository["Service"]["get"] = (projectId) =>
    selectById(projectId).pipe(Effect.map((rows) => rows[0]?.project ?? null));

  const findOpen: PersonalProjectRepository["Service"]["findOpen"] = (input) =>
    selectOpen(input.leadBotId, input.name.trim()).pipe(
      Effect.map((rows) => rows[0]?.project ?? null),
    );

  const history: PersonalProjectRepository["Service"]["history"] = (projectId) =>
    selectById(projectId).pipe(Effect.map((rows) => rows[0]?.history ?? []));

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
      const why =
        input.why === undefined
          ? undefined
          : input.why === null || input.why.trim().length === 0
            ? null
            : input.why.trim();
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
                  state, closed_at, created_at, updated_at, why, history_json
                )
                VALUES (
                  ${created}, ${input.leadBotId}, ${input.threadId}, ${name},
                  ${JSON.stringify(steps)}, ${estimate?.dueAt ?? null},
                  ${estimate?.estimatedAt ?? null}, 'open', NULL, ${at}, ${at},
                  ${why ?? null}, '[]'
                )
              `.pipe(Effect.mapError(sqlFailure("save")));
              return created;
            }
            const nextHistory = historyAfterUpdate(
              existing.history,
              existing.project.steps,
              steps,
              at,
            );
            yield* sql`
              UPDATE personal_projects
              SET thread_id = COALESCE(${input.threadId}, thread_id),
                  steps_json = ${steps === undefined ? sql`steps_json` : JSON.stringify(steps)},
                  due_at = ${estimate === undefined ? sql`due_at` : estimate.dueAt},
                  estimated_at = ${estimate === undefined ? sql`estimated_at` : estimate.estimatedAt},
                  state = ${input.close ?? "open"},
                  closed_at = ${input.close === undefined ? null : at},
                  updated_at = ${at},
                  why = ${why === undefined ? sql`why` : why},
                  history_json = ${JSON.stringify(
                    Schema.encodeSync(Schema.Array(PersonalProjectHistoryEntry))(nextHistory),
                  )}
              WHERE project_id = ${existing.project.projectId}
            `.pipe(Effect.mapError(sqlFailure("save")));
            return existing.project.projectId;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PersonalTasksError" ? error : sqlFailure("save")(error),
          ),
        );
      const stored = (yield* selectById(projectId))[0];
      if (stored === undefined) return yield* fail("The project could not be read after saving.");
      return stored.project;
    });

  /** Which chats work on each goal, from its linked tasks' last update. */
  const chatsByProject = (projects: ReadonlyArray<PersonalProject>) =>
    Effect.gen(function* () {
      if (projects.length === 0) return new Map<string, ReadonlyArray<ThreadId>>();
      const rows = yield* sql<{
        readonly projectId: string;
        readonly threadId: string;
        readonly at: string;
      }>`
        SELECT project_id AS "projectId", thread_id AS "threadId", MAX(updated_at) AS "at"
        FROM personal_tasks
        WHERE ${sql.in(
          "project_id",
          projects.map((project) => project.projectId),
        )}
          AND thread_id IS NOT NULL
        GROUP BY project_id, thread_id
      `.pipe(Effect.mapError(sqlFailure("read")));
      const grouped = new Map<string, Array<{ readonly threadId: string; readonly at: string }>>();
      for (const row of rows) {
        const rowsOfProject = grouped.get(row.projectId) ?? [];
        rowsOfProject.push({ threadId: row.threadId, at: row.at });
        grouped.set(row.projectId, rowsOfProject);
      }
      return new Map(
        projects.map((project) => [
          project.projectId,
          chatListOf(project.threadId, grouped.get(project.projectId) ?? []),
        ]),
      );
    });

  const list: PersonalProjectRepository["Service"]["list"] = () =>
    Effect.gen(function* () {
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: PROJECT_CLOSED_LIST_DAYS }),
      );
      const projects = yield* sql`
        SELECT ${sql.literal(PROJECT_COLUMNS)} FROM personal_projects p
        WHERE p.state = 'open' OR p.closed_at >= ${since}
        ORDER BY "lastActivityAt" DESC, p.created_at DESC
      `.pipe(
        Effect.mapError(sqlFailure("read")),
        Effect.flatMap(decodeAll),
        Effect.map(projectsOf),
      );
      const chats = yield* chatsByProject(projects);
      return projects.map((project) => ({
        ...project,
        chats: chats.get(project.projectId) ?? [],
      }));
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
    history,
    removeForLead,
  } satisfies PersonalProjectRepository["Service"];
});

export const layer = Layer.effect(PersonalProjectRepository, make);
