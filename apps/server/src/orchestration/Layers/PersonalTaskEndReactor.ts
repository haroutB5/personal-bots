/**
 * A task that ends (stopped, cancelled, failed, completed, interrupted) gives
 * the user's PC back. A bot that is stopped mid-desktop-action never runs
 * `computer_release`, and its holder used to linger until the 2-minute idle
 * timeout, so the Computer screen kept offering "Stop <bot>" for a bot that was
 * already gone (QA f9e48571). The browser's side of the same transition lives
 * in PersonalBrowser's tasks.changes hook; this is the desktop's, a separate
 * reactor because the browser layer must not depend on the desktop one.
 */
import { PERSONAL_TASK_TERMINAL_STATUSES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PersonalDesktop } from "../../personal/desktop/PersonalDesktop.ts";
import { PersonalTaskService } from "../../personal/tasks/PersonalTaskService.ts";

export const PersonalTaskEndReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService;
    const desktop = yield* PersonalDesktop;
    yield* Stream.runForEach(tasks.changes, (task) =>
      PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status) && task.threadId !== null
        ? desktop.threadTurnEnded(task.threadId)
        : Effect.void,
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  }),
);
