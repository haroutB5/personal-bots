import { PersonalBotId, type PersonalTask } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { URGENT_REPORT_PREFIX } from "./proposalLedger.ts";
import { quietWindowEnd, updatesQuietHoursVerdict } from "./quietHours.ts";
import { UPDATES_BOT_ID } from "./reviewPrompts.ts";

const task = (idempotencyKey: string, summary = "report", botId = UPDATES_BOT_ID) =>
  ({
    botId,
    idempotencyKey,
    objective: summary,
    result: { summary },
  }) as unknown as Pick<PersonalTask, "botId" | "idempotencyKey" | "objective" | "result">;

const NIGHTLY = "routine:routine-claude-code-nightly:2026-09-25T04:00";
const REPORT = "routine:routine-claude-code-report:event:2026-09-25T03:40:00.000Z";
// 04:40 BST.
const NIGHT = Date.parse("2026-09-25T03:40:00Z");
const SEVEN_BST = Date.parse("2026-09-25T06:00:00Z");

it("the window is 00:00 to 07:00 London, across both clock changes", () => {
  assert.strictEqual(quietWindowEnd(NIGHT), SEVEN_BST);
  assert.strictEqual(quietWindowEnd(Date.parse("2026-09-24T23:00:00Z")), SEVEN_BST); // 00:00 BST
  assert.strictEqual(quietWindowEnd(Date.parse("2026-09-24T22:59:00Z")), null); // 23:59 BST
  assert.strictEqual(quietWindowEnd(SEVEN_BST), null); // 07:00 exactly
  // Winter (GMT): 04:00 GMT, window ends 07:00 GMT.
  assert.strictEqual(
    quietWindowEnd(Date.parse("2026-12-01T04:00:00Z")),
    Date.parse("2026-12-01T07:00:00Z"),
  );
});

it("at night the run's own finish is dropped and the morning report waits for 07:00", () => {
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(NIGHTLY), "routine_result", NIGHT), {
    _tag: "Drop",
  });
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(REPORT), "routine_result", NIGHT), {
    _tag: "DeferUntil",
    atMs: SEVEN_BST,
  });
});

it("something broken goes out at once, quiet hours or not", () => {
  const urgent = task(
    REPORT,
    `${URGENT_REPORT_PREFIX}: Nightly update 2026-09-25: Bots may be down`,
  );
  assert.deepStrictEqual(updatesQuietHoursVerdict(urgent, "routine_result", NIGHT), {
    _tag: "Now",
  });
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(NIGHTLY), "task_failed", NIGHT), {
    _tag: "Now",
  });
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(NIGHTLY), "task_needs_input", NIGHT), {
    _tag: "Now",
  });
});

it("in the day, and for every other bot, nothing changes", () => {
  const day = Date.parse("2026-09-25T13:00:00Z");
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(NIGHTLY), "routine_result", day), {
    _tag: "Now",
  });
  assert.deepStrictEqual(updatesQuietHoursVerdict(task(REPORT), "routine_result", day), {
    _tag: "Now",
  });
  const other = task(NIGHTLY, "x", PersonalBotId.make("someone-else"));
  assert.deepStrictEqual(updatesQuietHoursVerdict(other, "routine_result", NIGHT), { _tag: "Now" });
});

it("anything else the Updates bot finishes at night is held for the morning, not lost", () => {
  assert.deepStrictEqual(
    updatesQuietHoursVerdict(task("user:chat-task"), "task_completed", NIGHT),
    { _tag: "DeferUntil", atMs: SEVEN_BST },
  );
});
