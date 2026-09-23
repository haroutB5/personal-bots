import type { FormEvent, JSX } from "react";
import { useMemo, useRef, useState } from "react";

import {
  PERSONAL_GROUP_MAX_MEMBERS,
  PersonalGroupId,
  ThreadId,
  type PersonalBot,
  type PersonalBotId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { randomUUID } from "~/lib/utils";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { PersonalPageHeader } from "./BotForm";
import { commandFailureMessage } from "./commandFeedback";
import { personalGroupCreate } from "./usePersonalGroups";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const NAME_MAX = 60;

/**
 * /bots/groups/new — a name and who is in it. Nothing else: no avatar (the
 * members are the avatar), no budget field (frozen server-side at the default),
 * no description [Grok: subtraction].
 *
 * The cap is six, and the counter says so before the seventh tap is refused:
 * every member keeps its own provider session, so the whole transcript is
 * stored once per member (§1.3).
 */
export function NewGroupScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const navigate = useNavigate();
  const list = usePersonalBotsList(environmentId);
  const createGroup = useAtomCommand(personalGroupCreate, { reportFailure: false });
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Checked on submit, like the bot editor: a disabled "Create group" with no
  // word about why left the owner hunting for the Name field a screen above.
  const [nameError, setNameError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const botsRef = useRef<HTMLFieldSetElement | null>(null);
  // Minted once per form, not per submit: a retried create returns the first
  // group instead of making a second one, exactly as `personalBots.create` does.
  const ids = useRef({ groupId: randomUUID(), threadId: randomUUID() });

  const bots = useMemo(() => (list.data?.bots ?? []).filter((bot) => bot.enabled), [list.data]);
  const full = picked.length >= PERSONAL_GROUP_MAX_MEMBERS;
  const canSubmit = !busy && environmentId !== null;

  const toggle = (bot: PersonalBot) => {
    setError(null);
    setPickError(null);
    setPicked((current) =>
      current.includes(bot.botId)
        ? current.filter((id) => id !== bot.botId)
        : full
          ? current
          : [...current, bot.botId],
    );
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || environmentId === null) return;
    const missingName = name.trim().length === 0;
    const missingBots = picked.length < 2;
    setNameError(missingName ? "Give the group a name." : null);
    setPickError(missingBots ? "Pick at least two bots. A group of one is a chat." : null);
    if (missingName) {
      nameRef.current?.focus();
      nameRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (missingBots) {
      botsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      botsRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus({
        preventScroll: true,
      });
      return;
    }
    setBusy(true);
    const groupId = PersonalGroupId.make(ids.current.groupId);
    const result = await createGroup({
      environmentId,
      input: {
        groupId,
        threadId: ThreadId.make(ids.current.threadId),
        name: name.trim(),
        // Order is the order they were picked: the first is the default
        // speaker when a message names nobody (§2.4).
        botIds: picked as ReadonlyArray<PersonalBotId>,
      },
    });
    setBusy(false);
    const failure = commandFailureMessage(result, "Couldn't create this group. Try again.");
    if (failure !== null) {
      setError(failure);
      return;
    }
    await navigate({ to: "/bots/groups/$groupId", params: { groupId }, replace: true });
  };

  return (
    <div className="px-5">
      <PersonalPageHeader title="New group" />
      {environmentId === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          Connect to your computer to create a group.
        </p>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} className="mt-2 flex flex-col gap-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--personal-text)]">
              Name
            </span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value.slice(0, NAME_MAX));
                if (event.target.value.trim().length > 0) setNameError(null);
              }}
              placeholder="e.g. Launch crew"
              aria-invalid={nameError !== null || undefined}
              aria-describedby={nameError !== null ? "new-group-name-error" : undefined}
              className={cn(
                "h-11 w-full rounded-[var(--personal-radius-button)] border bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
                nameError !== null
                  ? "border-[var(--personal-error)]"
                  : "border-[var(--personal-border-strong)]",
              )}
            />
            {nameError !== null ? (
              <span
                id="new-group-name-error"
                className="mt-1.5 block text-[13px] text-[var(--personal-error)]"
              >
                {nameError}
              </span>
            ) : null}
          </label>

          <fieldset
            ref={botsRef}
            className="min-w-0 scroll-mt-4"
            aria-describedby={pickError !== null ? "new-group-pick-error" : undefined}
          >
            <legend className="flex w-full items-baseline justify-between gap-2 pb-1.5">
              <span className="text-sm font-medium text-[var(--personal-text)]">Bots</span>
              <span
                aria-live="polite"
                className={cn(
                  "text-sm tabular-nums",
                  full
                    ? "text-[var(--personal-review-text)]"
                    : "text-[var(--personal-text-secondary)]",
                )}
              >
                {picked.length} of {PERSONAL_GROUP_MAX_MEMBERS}
              </span>
            </legend>
            {bots.length === 0 ? (
              <p className="text-[15px] text-[var(--personal-text-secondary)]">
                {list.data === null ? "Loading your bots" : "Create a bot or two first."}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--personal-border)] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)]">
                {bots.map((bot) => {
                  const checked = picked.includes(bot.botId);
                  return (
                    <li key={bot.botId}>
                      <label
                        className={cn(
                          "flex min-h-14 w-full min-w-0 items-center gap-3 px-3.5 py-2",
                          !checked && full ? "opacity-40" : null,
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          // The cap is enforced by refusing the seventh tick,
                          // not by hiding bots: the list stays the roster.
                          disabled={!checked && full}
                          onChange={() => toggle(bot)}
                          className="size-5 shrink-0"
                        />
                        <BotAvatar
                          shape={bot.avatarShape}
                          color={bot.avatarColor}
                          size={34}
                          label={bot.name}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium text-[var(--personal-text)]">
                            {bot.name}
                          </span>
                          {bot.title.length > 0 ? (
                            <span className="block truncate text-[13px] text-[var(--personal-text-secondary)]">
                              {bot.title}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {pickError !== null ? (
              <p
                id="new-group-pick-error"
                className="mt-1.5 text-[13px] text-[var(--personal-error)]"
              >
                {pickError}
              </p>
            ) : null}
          </fieldset>

          {error !== null ? (
            <p role="alert" className="text-sm text-[var(--personal-error)]">
              {error}
            </p>
          ) : null}

          {/* Sticky: the roster runs to 20+ rows, and the action and the count
              it depends on stayed a long scroll below the fold. */}
          <div className="sticky bottom-0 -mx-5 flex flex-col gap-1.5 border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-5 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
            <button
              type="submit"
              disabled={!canSubmit}
              aria-busy={busy}
              className="h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create group"}
            </button>
            {picked.length < 2 && pickError === null ? (
              <p className="text-center text-[13px] text-[var(--personal-text-secondary)]">
                Pick at least two bots. A group of one is a chat.
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
