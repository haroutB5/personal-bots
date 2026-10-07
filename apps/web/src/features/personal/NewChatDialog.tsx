import type { EnvironmentId } from "@t3tools/contracts";
import type { JSX } from "react";
import { useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

import { chatNameClash } from "./chatNames";
import { RENAME_CHAT_MAX_CHARS, renameChatDraftTitle } from "./renameChat";
import { useBotOpenChatNames } from "./useBotOpenChatNames";
import { useKeyboardInset } from "./useKeyboardInset";

const PHONE_BUTTON = "max-sm:h-11 max-sm:text-[15px]";
/** Same as the rename sheet: the buttons never take the keyboard down mid-tap. */
const keepFieldFocus = (event: React.SyntheticEvent) => event.preventDefault();

/**
 * "+" in the chat chips: an optional name, then Start chat. An empty name
 * keeps today's auto-title (the chat is named after its first message).
 * A bot's open chats have unique names: a name another open chat has is
 * flagged under the field as it is typed and Start stays off; the server
 * refuses it too (`error`, e.g. two chats started at once).
 */
export function NewChatDialog(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
  readonly botName: string;
  readonly starting: boolean;
  /** The server's refusal of the last Start (a name taken meanwhile), shown until the name changes. */
  readonly error?: string | null;
  readonly onDraftChange?: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (title: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardInset = useKeyboardInset();
  const errorId = useId();
  const openChats = useBotOpenChatNames(props.environmentId, props.botId);
  const [draft, setDraft] = useState("");
  const [wasOpen, setWasOpen] = useState(props.open);
  // A fresh, empty field per opening.
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setDraft("");
  }
  const name = renameChatDraftTitle(draft, "");
  const clash =
    name === null
      ? null
      : chatNameClash(
          name,
          openChats.map((chat) => chat.title),
        );
  const problem = clash ?? props.error ?? null;
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup
        initialFocus={inputRef}
        className="personal-app max-w-lg border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)] max-sm:pb-[env(safe-area-inset-bottom)]"
        style={keyboardInset > 0 ? { marginBottom: keyboardInset, paddingBottom: 0 } : undefined}
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle className="text-[18px] leading-snug text-[var(--personal-text)]">
            New chat with {props.botName}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.starting && clash === null) props.onStart(draft);
          }}
        >
          <div className="px-6 pb-4">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={RENAME_CHAT_MAX_CHARS}
              placeholder="Name (optional)"
              aria-label="Chat name (optional)"
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? errorId : undefined}
              autoComplete="off"
              enterKeyHint="go"
              onChange={(event) => {
                setDraft(event.target.value);
                props.onDraftChange?.();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                props.onOpenChange(false);
              }}
              // 16px keeps iOS from zooming the page when the field takes focus.
              className="h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-bg)] px-3 text-[16px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            />
            {problem !== null ? (
              <p
                id={errorId}
                role="alert"
                className="mt-2 text-[14px] leading-snug text-[var(--personal-error)]"
              >
                {problem}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter className="border-[var(--personal-border)] bg-transparent">
            <Button
              type="button"
              variant="outline"
              className={PHONE_BUTTON}
              onPointerDown={keepFieldFocus}
              onMouseDown={keepFieldFocus}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={props.starting || clash !== null}
              className={PHONE_BUTTON}
              onPointerDown={keepFieldFocus}
              onMouseDown={keepFieldFocus}
            >
              {props.starting ? "Starting…" : "Start chat"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
