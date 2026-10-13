import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotAvatar } from "./BotAvatar";
import { chipsShownFor } from "./chatChipHandoff";
import { botActiveModelShortLabel } from "./botModelLabel";
import { ConversationHeaderIdentity } from "./ConversationHeaderName";
import { conversationHeaderCaption } from "./conversationModel";
import { perfOptimizationOn } from "./perfFlags";
import { usePersonalBackTarget } from "./usePersonalBackTarget";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/**
 * Whether the full chat may mount yet. False for the first frame of the chat
 * route: tapping a chat used to render the whole conversation (every hook,
 * subscription, the transcript and the composer) inside the tap's own task,
 * about 300 ms at 4x CPU with a long history, before anything moved. The route
 * now paints ConversationShellHeader first and mounts the chat right after
 * that paint. Only the route's first mount waits: switching chats in the
 * desktop pane keeps the mounted screen. Kill switch: bots:perf-off =
 * "chat-shell-first".
 */
export function useChatMountAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(() => !perfOptimizationOn("chat-shell-first"));
  useEffect(() => {
    if (ready || typeof requestAnimationFrame !== "function") {
      setReady(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setReady(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ready]);
  return ready;
}

/**
 * The chat's header as its first frame: the same Back link, avatar, name and
 * model line the conversation draws (from the bots list, already loaded when
 * a chat row is tapped), over an empty body. Replaced by the real screen one
 * frame later; nothing in it is interactive beyond Back.
 */
export function ConversationShellHeader({ botId }: { readonly botId: string }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const backTarget = usePersonalBackTarget();
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  let identity: ReactNode = null;
  if (bot !== null) {
    identity = (
      <div className="flex min-h-11 min-w-0 flex-1 items-center gap-1">
        <span className="grid size-11 shrink-0 place-items-center">
          <BotAvatar
            shape={bot.avatarShape}
            color={bot.avatarColor}
            size={36}
            label={bot.name}
            thought="header"
          />
        </span>
        <div className="min-w-0 flex-1 px-1">
          <ConversationHeaderIdentity
            name={bot.name}
            chatTitle={null}
            muted={false}
            contextBadge={null}
            caption={conversationHeaderCaption({
              state: "idle",
              thinking: false,
              statusLabel: "",
              modelLabel: botActiveModelShortLabel(bot, providers),
            })}
          />
        </div>
      </div>
    );
  }
  return (
    <div
      data-chat-shell-first=""
      className="relative flex h-full min-h-0 flex-col overflow-clip"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
    >
      {/* As tall as the real header will be (52 + the 48 px chip strip when the
          bot's chats show one), so the chat mounting does not drop it. */}
      <header
        className={cn(
          "personal-column flex shrink-0 flex-col border-b-[var(--personal-hairline)] border-[var(--personal-border)] bg-[var(--personal-bg)]",
          chipsShownFor(botId) ? "h-[100px]" : "h-[52px]",
        )}
      >
        <div className="flex h-[52px] items-center gap-1 px-2">
          <Link
            to={backTarget.to}
            activeOptions={{ exact: true }}
            aria-label={backTarget.label}
            className={cn(ICON_BUTTON, "md:hidden")}
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          {identity}
        </div>
      </header>
      <div className="min-h-0 flex-1" />
    </div>
  );
}
