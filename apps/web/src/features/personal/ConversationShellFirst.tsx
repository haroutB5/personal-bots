import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotAvatar } from "./BotAvatar";
import { botModelShortLabel } from "./botModelLabel";
import { ConversationHeaderName } from "./ConversationHeaderName";
import { ConversationSubtitle } from "./ConversationSubtitle";
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
      <div className="flex min-h-11 min-w-0 flex-1 items-center gap-4">
        <BotAvatar
          shape={bot.avatarShape}
          color={bot.avatarColor}
          size={48}
          label={bot.name}
          thought="header"
        />
        <div className="min-w-0 flex-1">
          <ConversationHeaderName
            name={bot.name}
            chatTitle={null}
            muted={false}
            contextBadge={null}
          />
          <ConversationSubtitle
            state="idle"
            modelLabel={botModelShortLabel(bot.modelSelection, providers)}
            status=""
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
      <header className="personal-column flex h-16 shrink-0 items-center gap-3 px-2">
        <Link
          to={backTarget.to}
          aria-label={backTarget.label}
          className={cn(ICON_BUTTON, "md:hidden")}
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        {identity}
      </header>
      <div className="min-h-0 flex-1" />
    </div>
  );
}
