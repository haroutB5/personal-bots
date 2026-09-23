import type { JSX } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { ComputerScreen } from "./computer/ComputerScreen";
import { ConversationRoutinesPanel } from "./ConversationRoutinesPanel";

export const CONVERSATION_SIDE_PANEL_ID = "conversation-side-panel";

/**
 * Wide desktop only (the chat decides when it fits): the Computer pinned
 * beside the conversation, so the bot's browser can be followed, or taken
 * over, without leaving the chat [Grok: the computer as a side panel]. The
 * bot's routines move here too, out of the strip that squeezed the transcript.
 *
 * Nothing new is drawn: it is the Computer screen and the routines strip,
 * rehoused on the chat's own sheet behind a hairline.
 */
export function ConversationSidePanel({
  environmentId,
  botId,
  threadId,
  showRoutines,
  onHideRoutines,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
  readonly threadId: string;
  readonly showRoutines: boolean;
  readonly onHideRoutines: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  return (
    <aside
      id={CONVERSATION_SIDE_PANEL_ID}
      aria-label="Computer and routines"
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-[var(--personal-border)] min-[1800px]:w-[400px]"
    >
      <ComputerScreen
        variant="panel"
        origin={{ botId, threadId }}
        // No Back in the panel; kept for the screen's contract.
        onBackToChat={(target) =>
          void (target === null
            ? navigate({ to: "/bots" })
            : navigate({ to: "/bots/$botId/$threadId", params: target }))
        }
      />
      {showRoutines ? (
        <ConversationRoutinesPanel
          environmentId={environmentId}
          botId={botId}
          onHide={onHideRoutines}
        />
      ) : null}
    </aside>
  );
}
