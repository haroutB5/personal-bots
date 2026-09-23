import type { CSSProperties, JSX } from "react";
import { useRef } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { ComputerScreen } from "./computer/ComputerScreen";
import { ConversationRoutinesPanel } from "./ConversationRoutinesPanel";
import {
  SIDE_PANEL_WIDTH,
  SIDEBAR_ID,
  sidePanelMaxWidth,
  sidePanelWidthCss,
} from "./desktopColumns";
import { setPersonalNumberPreference, usePersonalNumberPreference } from "./personalPreferences";

export const CONVERSATION_SIDE_PANEL_ID = "conversation-side-panel";

/**
 * Wide desktop only (the chat decides when it fits): the Computer pinned
 * beside the conversation, so the bot's browser can be followed, or taken
 * over, without leaving the chat [Grok: the computer as a side panel]. The
 * bot's routines move here too, out of the strip that squeezed the transcript.
 *
 * Nothing new is drawn: it is the Computer screen and the routines strip,
 * rehoused on the chat's own sheet behind a hairline. Its left edge drags
 * to resize it (see `desktopColumns` for the limits).
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
  const panelRef = useRef<HTMLElement | null>(null);
  const width = usePersonalNumberPreference("sidePanelWidth");
  const measure = () => panelRef.current?.getBoundingClientRect().width ?? null;
  return (
    <aside
      ref={panelRef}
      id={CONVERSATION_SIDE_PANEL_ID}
      aria-label="Computer and routines"
      className="relative flex h-full shrink-0 flex-col border-l border-[var(--personal-border)]"
      style={
        {
          "--personal-side-panel-width": `${width}px`,
          width: sidePanelWidthCss(),
        } as CSSProperties
      }
    >
      <ColumnResizeHandle
        label="Resize computer and routines panel"
        edge="left"
        controls={CONVERSATION_SIDE_PANEL_ID}
        value={width}
        min={SIDE_PANEL_WIDTH.min}
        maxWidth={() =>
          sidePanelMaxWidth(
            window.innerWidth,
            document.getElementById(SIDEBAR_ID)?.getBoundingClientRect().width ?? 0,
          )
        }
        defaultWidth={SIDE_PANEL_WIDTH.default}
        cssVar="--personal-side-panel-width"
        target={() => panelRef.current}
        measure={measure}
        onCommit={(next) => setPersonalNumberPreference("sidePanelWidth", next)}
      />
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
