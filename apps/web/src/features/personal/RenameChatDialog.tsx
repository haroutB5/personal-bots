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
import { useKeyboardInset } from "./useKeyboardInset";

const PHONE_BUTTON = "max-sm:h-11 max-sm:text-[15px]";

/**
 * Save and Cancel keep the keyboard up until their click has landed. iOS blurs
 * the field partway through a tap on a button, before the click: the keyboard
 * starts down, the sheet sitting on it drops out from under the finger and the
 * tap only closes the keyboard, so Save needed a second tap.
 */
const keepFieldFocus = (event: React.SyntheticEvent) => event.preventDefault();

/**
 * The field and its two buttons. Enter saves through the form, Escape
 * cancels; Save stays disabled while the trimmed draft is empty or unchanged.
 * A refusal keeps the dialog open with the server's message under the field.
 * A name another open chat of the bot has (`takenTitles`, without this chat's
 * own) is flagged under the field as it is typed and Save stays off.
 */
export function RenameChatForm(props: {
  readonly initialTitle: string;
  readonly takenTitles?: ReadonlyArray<string>;
  readonly inputRef?: React.Ref<HTMLInputElement>;
  readonly onSave: (title: string) => Promise<string | null>;
  readonly onCancel: () => void;
}): JSX.Element {
  const { initialTitle, onSave, onCancel } = props;
  const [draft, setDraft] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef(false);
  const errorId = useId();
  const title = renameChatDraftTitle(draft, initialTitle);
  const clash = title === null ? null : chatNameClash(title, props.takenTitles ?? []);
  const problem = clash ?? error;

  const submit = async (form: HTMLFormElement) => {
    if (title === null || clash !== null || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSave(title);
    setSaving(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    // Saved: take the keyboard down with the sheet rather than after it.
    const focused = form.ownerDocument.activeElement as HTMLElement | null;
    if (focused !== null && form.contains(focused)) focused.blur();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
    >
      <div className="px-6 pb-4">
        <input
          ref={props.inputRef}
          type="text"
          value={draft}
          maxLength={RENAME_CHAT_MAX_CHARS}
          placeholder="Chat title"
          aria-label="Chat title"
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? errorId : undefined}
          autoComplete="off"
          enterKeyHint="done"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onFocus={(event) => {
            // Select once, when the dialog opens, so typing replaces the title.
            if (selectedRef.current) return;
            selectedRef.current = true;
            event.currentTarget.select();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onCancel();
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
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={title === null || clash !== null || saving}
          className={PHONE_BUTTON}
          onPointerDown={keepFieldFocus}
          onMouseDown={keepFieldFocus}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

/**
 * "Rename chat" from the chat menu, drawn like the app's confirms. On a phone
 * it is a bottom sheet; where the keyboard only shrinks the visual viewport
 * (so it would sit over a fixed sheet) the sheet is lifted by the overlap.
 */
export function RenameChatDialog(props: {
  readonly open: boolean;
  readonly initialTitle: string;
  /** The names of the bot's other open chats (not the one being renamed). */
  readonly takenTitles?: ReadonlyArray<string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (title: string) => Promise<string | null>;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardInset = useKeyboardInset();
  // A fresh form per opening, so it always starts from the current title,
  // while the old one stays on screen through the closing animation.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setSession((current) => current + 1);
  }
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup
        initialFocus={inputRef}
        className="personal-app max-w-lg border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)] max-sm:pb-[env(safe-area-inset-bottom)]"
        style={keyboardInset > 0 ? { marginBottom: keyboardInset, paddingBottom: 0 } : undefined}
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle className="text-[18px] leading-snug text-[var(--personal-text)]">
            Rename chat
          </AlertDialogTitle>
        </AlertDialogHeader>
        <RenameChatForm
          key={session}
          initialTitle={props.initialTitle}
          {...(props.takenTitles === undefined ? {} : { takenTitles: props.takenTitles })}
          inputRef={inputRef}
          onCancel={() => props.onOpenChange(false)}
          onSave={async (title) => {
            const failure = await props.onSave(title);
            if (failure === null) props.onOpenChange(false);
            return failure;
          }}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
