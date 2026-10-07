import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import type { JSX } from "react";
import { useCallback, useRef, useState } from "react";

import { NewChatDialog } from "./NewChatDialog";
import { renameChatDraftTitle } from "./renameChat";
import { useStartBotChat } from "./startBotChat";

/** How one entry point wants its new chat opened (each keeps its own Back behaviour). */
export interface NewChatPromptOptions {
  /** Swap the current history entry for the new chat. */
  readonly replace?: boolean | undefined;
  /** Carry the current history state to the new chat. */
  readonly keepState?: boolean | undefined;
  /** Runs when Start chat is pressed, before the chat is created. */
  readonly onBeforeStart?: (() => void) | undefined;
}

/**
 * Every "New chat" button asks for a name first: it opens the "New chat with
 * <bot>" sheet, and Start chat creates the chat already titled, so it never
 * shows "New chat" and needs no rename afterwards. An empty name keeps the
 * auto-title from the first message. A name another open chat of the bot has
 * is refused (flagged in the sheet as it is typed; the server refuses it too).
 *
 * `open` shows the sheet, `dialog` is rendered once beside the button. The
 * sheet mounts on first use, so a list of bot rows carries no extra listeners.
 */
export function useNewChatPrompt(
  environmentId: EnvironmentId | null,
  bot: { readonly botId: PersonalBotId; readonly name: string } | null,
): {
  readonly open: (options?: NewChatPromptOptions) => void;
  readonly starting: boolean;
  readonly dialog: JSX.Element | null;
} {
  const botId = bot?.botId ?? null;
  const { start, starting } = useStartBotChat(environmentId, botId);
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // The server's refusal of the last Start (a name another chat took meanwhile).
  const [refusal, setRefusal] = useState<string | null>(null);
  const options = useRef<NewChatPromptOptions>({});
  // A second Start chat before the first has finished must not make a second chat.
  const busy = useRef(false);

  const open = useCallback(
    (next?: NewChatPromptOptions) => {
      if (botId === null) return;
      options.current = next ?? {};
      setRefusal(null);
      setMounted(true);
      setIsOpen(true);
    },
    [botId],
  );

  const onStart = async (title: string) => {
    if (busy.current) return;
    busy.current = true;
    let outcome: Awaited<ReturnType<typeof start>>;
    try {
      const name = renameChatDraftTitle(title, "");
      const { replace, keepState, onBeforeStart } = options.current;
      onBeforeStart?.();
      outcome = await start({
        ...(replace === undefined ? {} : { replace }),
        ...(keepState === undefined ? {} : { keepState }),
        ...(name === null ? {} : { title: name }),
      });
    } finally {
      busy.current = false;
    }
    // A refusal keeps the sheet open with the reason under the field: the name
    // can be changed and Start pressed again.
    if (!outcome.ok) {
      setRefusal(outcome.message);
      return;
    }
    // Gone, not fading out: the screen it was opened from may be hidden by now,
    // and a sheet that cannot finish its exit animation would linger in the page.
    setIsOpen(false);
    setMounted(false);
  };

  const dialog =
    bot !== null && mounted ? (
      <NewChatDialog
        open={isOpen}
        environmentId={environmentId}
        botId={bot.botId}
        botName={bot.name}
        starting={starting}
        error={refusal}
        onDraftChange={() => setRefusal(null)}
        onOpenChange={setIsOpen}
        onStart={(title) => void onStart(title)}
      />
    ) : null;

  return { open, starting, dialog };
}
