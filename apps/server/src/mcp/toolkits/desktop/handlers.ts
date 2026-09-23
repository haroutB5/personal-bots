import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as DesktopActions from "../../../personal/desktop/desktopActions.ts";
import type { DesktopClaimant } from "../../../personal/desktop/DesktopLock.ts";
import {
  type DesktopActionContext,
  PersonalDesktop,
  type PersonalDesktopActionError,
} from "../../../personal/desktop/PersonalDesktop.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DesktopImageToolkit, DesktopStandardToolkit, DesktopToolError } from "./tools.ts";

const toolError = (reason: string) => new DesktopToolError({ reason });
const fromActionError = (error: PersonalDesktopActionError) => toolError(error.reason);

const make = Effect.gen(function* () {
  const desktop = yield* PersonalDesktop;
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;

  // Personal-bot threads only: the "bots" capability is what marks one, and
  // the thread link names the bot the overlay and the queue show.
  const caller = Effect.fn("DesktopToolkit.caller")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("bots");
    const link = yield* botRepository
      .getThreadLink({ threadId: scope.threadId })
      .pipe(Effect.mapError(() => toolError("Could not look up this thread's bot.")));
    if (Option.isNone(link)) {
      return yield* toolError("This thread does not belong to a personal bot.");
    }
    const bot = yield* botRepository
      .getBotById({ botId: link.value.botId })
      .pipe(Effect.mapError(() => toolError("Could not look up this thread's bot.")));
    const claimant: DesktopClaimant = {
      threadId: scope.threadId,
      botId: link.value.botId,
      botName: Option.isSome(bot) ? bot.value.name : "A bot",
    };
    return claimant;
  });

  const act = <A>(operation: string, run: (context: DesktopActionContext) => Promise<A>) =>
    Effect.gen(function* () {
      const claimant = yield* caller();
      return yield* desktop.act(claimant, operation, run).pipe(Effect.mapError(fromActionError));
    });

  return { act, caller };
});

export const DesktopImageToolkitHandlersLive = DesktopImageToolkit.toLayer(
  Effect.gen(function* () {
    const { act } = yield* make;
    return DesktopImageToolkit.of({
      computer_screenshot: (input) =>
        act("screenshot", (context) => DesktopActions.captureShot(context, input.monitor)),
      computer_zoom: (input) => act("zoom", (context) => DesktopActions.zoomShot(context, input)),
      computer_click: (input) => act("click", (context) => DesktopActions.click(context, input)),
      computer_move: (input) => act("move", (context) => DesktopActions.move(context, input)),
      computer_drag: (input) => act("drag", (context) => DesktopActions.drag(context, input)),
      computer_scroll: (input) => act("scroll", (context) => DesktopActions.scroll(context, input)),
      computer_type: (input) => act("type", (context) => DesktopActions.typeText(context, input)),
      computer_key: (input) => act("key", (context) => DesktopActions.pressKeys(context, input)),
    });
  }),
);

export const DesktopStandardToolkitHandlersLive = DesktopStandardToolkit.toLayer(
  Effect.gen(function* () {
    const { act, caller } = yield* make;
    const desktop = yield* PersonalDesktop;
    return DesktopStandardToolkit.of({
      computer_cursor_position: () =>
        act("cursor", (context) => DesktopActions.cursorPosition(context)),
      computer_release: () =>
        Effect.gen(function* () {
          const claimant = yield* caller();
          const released = yield* desktop.release(claimant.threadId);
          return {
            released,
            note: released
              ? "The PC is handed back to the user."
              : "You were not holding the PC; nothing to release.",
          };
        }),
    });
  }),
);
