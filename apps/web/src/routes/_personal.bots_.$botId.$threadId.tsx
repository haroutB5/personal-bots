import { createFileRoute } from "@tanstack/react-router";

import { ConversationScreen } from "~/features/personal/ConversationScreen";
import {
  ConversationShellHeader,
  useChatMountAfterFirstPaint,
} from "~/features/personal/ConversationShellFirst";

function ConversationRouteView() {
  const { botId, threadId } = Route.useParams();
  const { request } = Route.useSearch();
  // The header paints on the tap's frame; the chat mounts right after it.
  const ready = useChatMountAfterFirstPaint();
  if (!ready) return <ConversationShellHeader botId={botId} />;
  return <ConversationScreen botId={botId} threadId={threadId} requestId={request ?? null} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/$threadId")({
  // `?request=<id>`: the chat opens at that request card (SPEC 2.9, D13). The
  // push and any deep link carry it; a plain open lands on the chat's own open
  // request without it.
  validateSearch: (search: Record<string, unknown>): { readonly request?: string } =>
    typeof search["request"] === "string" && search["request"].length > 0
      ? { request: search["request"] }
      : {},
  component: ConversationRouteView,
});
