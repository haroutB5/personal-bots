import type { EnvironmentId, PersonalBot, ServerProvider } from "@t3tools/contracts";
import type { SecretAccessChoice } from "@hbots/personal-client/settings/secretAccess";

import type { ChatEnvironment } from "../chatEnvironment";
import type { NativePersonal } from "../../personal/nativePersonalClient";

/**
 * What every card in the feed may use. Cards own their own request state and
 * commands, so the chat screen only has to say who the chat's bot is and how to
 * open another chat.
 */
export interface CardContext {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly environmentId: EnvironmentId | null;
  /** The chat the cards are in, for the question card's commands. */
  readonly threadId: string;
  readonly nowMs: number;
  /** The bot whose chat this is, as every card's aria label names it. */
  readonly botName: string;
  readonly botNameOf: (botId: string) => string | undefined;
  readonly findBot: (botId: string) => PersonalBot | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** What a task parked on another bot is waiting on, by that bot's thread. */
  readonly waitingLabelFor: (threadId: string | null) => string | null;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly secrets: {
    readonly respondingIds: ReadonlySet<string>;
    readonly onProvide: (
      requestId: string,
      value: string,
      shared: boolean,
      access: SecretAccessChoice,
    ) => void;
    readonly onDecline: (requestId: string) => void;
  };
  readonly connectionApprovals: {
    readonly respondingIds: ReadonlySet<string>;
    readonly onDecide: (approvalId: string, decision: "approved" | "denied") => void;
  };
}
