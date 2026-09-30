import { createFileRoute } from "@tanstack/react-router";

import { ConversationScreen } from "~/features/personal/ConversationScreen";
import {
  ConversationShellHeader,
  useChatMountAfterFirstPaint,
} from "~/features/personal/ConversationShellFirst";

function ConversationRouteView() {
  const { botId, threadId } = Route.useParams();
  // The header paints on the tap's frame; the chat mounts right after it.
  const ready = useChatMountAfterFirstPaint();
  if (!ready) return <ConversationShellHeader botId={botId} />;
  return <ConversationScreen botId={botId} threadId={threadId} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/$threadId")({
  component: ConversationRouteView,
});
