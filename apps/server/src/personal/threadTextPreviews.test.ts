import { expect, it } from "@effect/vitest";
import type {
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  PersonalThreadFullTextInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemoryWorker } from "../persistence/Layers/Sqlite.ts";
import {
  COMMAND_PREVIEW_CHARS,
  REASONING_PREVIEW_CHARS,
  applyThreadTextPreviews,
  maybeApplyThreadTextPreviews,
  previewText,
  readThreadFullText,
} from "./threadTextPreviews.ts";

const at = "2026-10-26T03:00:00.000Z";
const long = "x".repeat(5_000);
const longCommand = `cat <<'EOF'\n${"y".repeat(4_000)}\nEOF`;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const message = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  role: "reasoning",
  text: long,
  turnId: "turn-old",
  streaming: false,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const command = (id: string, turnId = "turn-old", data: Record<string, unknown> = {}) =>
  ({
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: "Command run",
    payload: { itemType: "command_execution", title: "Command run", data },
    turnId,
    createdAt: at,
  }) as unknown as OrchestrationThreadActivity;

const snapshot = (
  messages: ReadonlyArray<unknown>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: unknown = { turnId: "turn-old", state: "completed" },
) =>
  ({
    snapshotSequence: 3,
    thread: { id: "thread-1", messages, activities, latestTurn, session: null },
  }) as unknown as OrchestrationThreadDetailSnapshot;

it("cuts a preview without splitting a surrogate pair", () => {
  expect(previewText("abcdef", 3)).toBe("abc…");
  expect(previewText("ab\u{1F600}cd", 3)).toBe("ab…");
});

it("previews finished reasoning and long commands outside the running turn", () => {
  const result = applyThreadTextPreviews(
    snapshot(
      [
        message("old"),
        message("short", { text: "brief" }),
        message("assistant", { role: "assistant" }),
        message("streaming", { streaming: true }),
        message("running", { turnId: "turn-new" }),
      ],
      [
        command("cmd", "turn-old", { command: longCommand }),
        command("item", "turn-old", {
          item: { command: longCommand, input: { command: longCommand } },
        }),
        command("short-cmd", "turn-old", { command: "ls" }),
        command("running-cmd", "turn-new", { command: longCommand }),
      ],
      { turnId: "turn-new", state: "running" },
    ),
  );
  const messages = result.thread.messages;
  expect(messages[0]!.text).toHaveLength(REASONING_PREVIEW_CHARS + 1);
  expect(messages[0]!.textTruncated).toBe(true);
  for (const kept of messages.slice(1)) {
    expect(kept.text === "brief" || kept.text === long).toBe(true);
    expect(kept.textTruncated).toBeUndefined();
  }
  const data = result.thread.activities.map(
    (activity) => (activity.payload as { data: Record<string, any> }).data,
  );
  expect(data[0]!.command).toHaveLength(COMMAND_PREVIEW_CHARS + 1);
  expect(data[0]!.commandTruncated).toBe(true);
  expect(data[1]!.item.command).toHaveLength(COMMAND_PREVIEW_CHARS + 1);
  expect(data[1]!.item.input.command).toHaveLength(COMMAND_PREVIEW_CHARS + 1);
  expect(data[1]!.commandTruncated).toBe(true);
  expect(data[2]).toEqual({ command: "ls" });
  expect(data[3]).toEqual({ command: longCommand });
});

it("returns the same snapshot when nothing is long", () => {
  const plain = snapshot([message("m", { text: "short" })], [command("c", "turn-old", {})]);
  expect(applyThreadTextPreviews(plain)).toBe(plain);
});

it("previews only when asked and while the switch is on", () => {
  const full = snapshot([message("m")], []);
  expect(maybeApplyThreadTextPreviews(full, false)).toBe(full);
  expect(maybeApplyThreadTextPreviews(full, true)).not.toBe(full);
  const previous = process.env.PB_PERF_OFF;
  process.env.PB_PERF_OFF = "text-previews";
  try {
    expect(maybeApplyThreadTextPreviews(full, true)).toBe(full);
  } finally {
    if (previous === undefined) delete process.env.PB_PERF_OFF;
    else process.env.PB_PERF_OFF = previous;
  }
});

it.effect("reads the whole text of the named messages and activities of one thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        ('m-1', 'thread-1', 'turn-old', 'reasoning', ${long}, 0, ${at}, ${at}),
        ('m-2', 'thread-2', 'turn-old', 'reasoning', 'other thread', 0, ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES (
        'a-1', 'thread-1', 'turn-old', 'tool', 'tool.completed', 'Command run',
        ${encodeJson({ itemType: "command_execution", data: { command: longCommand, stdout: "dropped" } })},
        ${at}
      )
    `;
    const result = yield* readThreadFullText({
      threadId: "thread-1",
      messageIds: ["m-1", "m-2"],
      activityIds: ["a-1"],
    } as unknown as PersonalThreadFullTextInput);
    expect(result.messages).toEqual([{ messageId: "m-1", text: long }]);
    expect(result.activities).toHaveLength(1);
    const payload = result.activities[0]!.payload as { data: Record<string, unknown> };
    expect(payload.data.command).toBe(longCommand);
    expect(payload.data).not.toHaveProperty("stdout");
  }).pipe(Effect.provide(SqlitePersistenceMemoryWorker)),
);
