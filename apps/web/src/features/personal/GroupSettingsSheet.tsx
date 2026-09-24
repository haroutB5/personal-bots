import type { JSX } from "react";
import { useState } from "react";

import {
  isGroupOnlyBot,
  PERSONAL_GROUP_MAX_MEMBERS,
  type PersonalBot,
  type PersonalGroup,
} from "@t3tools/contracts";
import { ChevronLeft, ChevronRight, Ellipsis, Plus } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { activeGroupMembers, addableBots, memberRemovalMessage } from "./groupModel";

/** Each action reports a failure in the owner's words, or null when it worked. */
export interface GroupMembersActions {
  readonly onEditBot: (botId: string) => void;
  readonly onNewBot: () => void;
  readonly onMessagePrivately: (botId: string) => Promise<string | null>;
  readonly onAddMember: (botId: string) => Promise<string | null>;
  readonly onRemoveMember: (botId: string) => Promise<string | null>;
  /** Asks before a removal; the app's confirm dialog unless a test swaps it. */
  readonly confirm?: (message: string) => Promise<boolean>;
}

const ROW_BUTTON =
  "flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left outline-none active:bg-[var(--personal-fill-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";
const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LIST_CLASS =
  "divide-y divide-[var(--personal-border)] overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";
const SECTION_LABEL = "mb-1.5 px-1 text-[13px] font-semibold text-[var(--personal-text-secondary)]";

async function defaultConfirm(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive", confirmLabel: "Remove" })) ??
    window.confirm(message)
  );
}

function BotLines({ bot, note }: { bot: PersonalBot; note?: string | null }): JSX.Element {
  const secondary = note ?? (bot.title.trim().length > 0 ? bot.title : null);
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[16px] leading-[21px] font-semibold text-[var(--personal-text)]">
        {bot.name}
      </span>
      {secondary !== null ? (
        <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
          {secondary}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The Members section of a group's settings: who is in it, and every way to
 * reach a member now that a bot only in groups is out of the Bots list. Tap a
 * member to edit it; its "..." menu messages it privately (which brings it
 * back to the list) or removes it. "Add member" picks an existing bot or
 * creates a new one straight into the group.
 *
 * Optimistic: an add shows at once as "Adding..." and a removal disappears at
 * once; a failure puts the row back and says why. The group feed then catches
 * up with the same answer, so nothing jumps.
 */
export function GroupMembersPanel({
  group,
  groups,
  bots,
  actions,
}: {
  readonly group: PersonalGroup;
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly actions: GroupMembersActions;
}): JSX.Element {
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const botsById = new Map(bots.map((bot) => [bot.botId as string, bot] as const));
  const memberIds = activeGroupMembers(group).map((member) => member.botId as string);
  // Settled members first, in the group's order, then adds still in flight.
  const shownIds = [
    ...memberIds.filter((botId) => !removing.has(botId)),
    ...[...adding].filter((botId) => !memberIds.includes(botId)),
  ];
  const full = shownIds.length >= PERSONAL_GROUP_MAX_MEMBERS;
  // A settled change stays in its pending set until the group itself shows it,
  // so a reply that beats the feed never flickers the row out and back.
  // Adjusted during render when the membership changes (no effect, no extra
  // commit): an add the group now shows, or a removal it no longer shows, is
  // settled.
  const memberKey = memberIds.join(",");
  const [seenMemberKey, setSeenMemberKey] = useState(memberKey);
  if (seenMemberKey !== memberKey) {
    setSeenMemberKey(memberKey);
    const now = new Set(memberIds);
    setAdding((current) => new Set([...current].filter((botId) => !now.has(botId))));
    setRemoving((current) => new Set([...current].filter((botId) => now.has(botId))));
  }
  const choices = addableBots(bots, group).filter((bot) => !adding.has(bot.botId));

  const setIn = (
    setter: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    botId: string,
    present: boolean,
  ) =>
    setter((current) => {
      const next = new Set(current);
      if (present) next.add(botId);
      else next.delete(botId);
      return next;
    });

  const add = async (botId: string) => {
    setPicking(false);
    setError(null);
    setIn(setAdding, botId, true);
    const failure = await actions.onAddMember(botId);
    if (failure !== null) setIn(setAdding, botId, false);
    setError(failure);
  };

  const remove = async (botId: string) => {
    const bot = botsById.get(botId) ?? null;
    const message = memberRemovalMessage({
      bot,
      botName: bot?.name ?? "this bot",
      group,
      groups,
    });
    if (!(await (actions.confirm ?? defaultConfirm)(message))) return;
    setError(null);
    setIn(setRemoving, botId, true);
    const failure = await actions.onRemoveMember(botId);
    if (failure !== null) setIn(setRemoving, botId, false);
    setError(failure);
  };

  const messagePrivately = async (botId: string) => {
    if (busyBot !== null) return;
    setError(null);
    setBusyBot(botId);
    const failure = await actions.onMessagePrivately(botId);
    setBusyBot(null);
    setError(failure);
  };

  if (picking) {
    return (
      <section aria-label="Add a member">
        <div className="mb-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPicking(false)}
            aria-label="Back to members"
            className={cn(ICON_BUTTON, "-ml-2 text-[var(--personal-text)]")}
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </button>
          <h3 className="text-[16px] font-semibold text-[var(--personal-text)]">Add a member</h3>
        </div>
        <ul className={LIST_CLASS}>
          <li className="flex">
            <button type="button" onClick={actions.onNewBot} className={cn(ROW_BUTTON, "pr-4")}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text)]">
                <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[16px] leading-[21px] font-semibold text-[var(--personal-text)]">
                  New bot
                </span>
                <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                  Create one straight into {group.name}
                </span>
              </span>
            </button>
          </li>
          {choices.map((bot) => (
            <li key={bot.botId} className="flex">
              <button
                type="button"
                onClick={() => void add(bot.botId)}
                aria-label={`Add ${bot.name}`}
                className={cn(ROW_BUTTON, "pr-4")}
              >
                <BotAvatar
                  shape={bot.avatarShape}
                  color={bot.avatarColor}
                  size={40}
                  label={bot.name}
                />
                <BotLines bot={bot} />
              </button>
            </li>
          ))}
        </ul>
        {choices.length === 0 ? (
          <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
            Every other bot is already in this group.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="Members">
      <h3 className={SECTION_LABEL}>
        Members · {shownIds.length} of {PERSONAL_GROUP_MAX_MEMBERS}
      </h3>
      <ul className={LIST_CLASS}>
        {shownIds.map((botId) => {
          const bot = botsById.get(botId) ?? null;
          const pending = adding.has(botId);
          const name = bot?.name ?? "Loading bot";
          return (
            <li key={botId} className={cn("flex items-center", pending && "opacity-60")}>
              <button
                type="button"
                disabled={bot === null || pending}
                onClick={() => actions.onEditBot(botId)}
                aria-label={`Edit ${name}`}
                className={ROW_BUTTON}
              >
                {bot !== null ? (
                  <BotAvatar
                    shape={bot.avatarShape}
                    color={bot.avatarColor}
                    size={40}
                    label={bot.name}
                  />
                ) : (
                  <span className="size-10 shrink-0 rounded-full bg-[var(--personal-fill-muted)]" />
                )}
                {bot !== null ? (
                  <BotLines
                    bot={bot}
                    note={
                      pending ? "Adding…" : busyBot === botId ? "Opening a private chat…" : null
                    }
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[16px] text-[var(--personal-text-secondary)]">
                    {name}
                  </span>
                )}
                <ChevronRight
                  aria-hidden="true"
                  className="size-5 shrink-0 text-[var(--personal-text-tertiary)]"
                  strokeWidth={1.75}
                />
              </button>
              <Menu>
                <MenuTrigger
                  disabled={bot === null || pending}
                  render={
                    <button
                      type="button"
                      aria-label={`Options for ${name}`}
                      className={cn(ICON_BUTTON, "mr-1")}
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" className="size-5" strokeWidth={1.75} />
                </MenuTrigger>
                <MenuPopup align="end" className="personal-app personal-menu min-w-52">
                  <MenuItem onClick={() => void messagePrivately(botId)}>
                    Message privately
                  </MenuItem>
                  <MenuItem onClick={() => actions.onEditBot(botId)}>Edit bot</MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => void remove(botId)}>
                    Remove from group
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </li>
          );
        })}
        <li className="flex">
          <button
            type="button"
            disabled={full}
            onClick={() => {
              setError(null);
              setPicking(true);
            }}
            className={cn(ROW_BUTTON, "pr-4 disabled:opacity-50")}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text)]">
              <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[16px] leading-[21px] font-semibold text-[var(--personal-text)]">
                Add member
              </span>
              {full ? (
                <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                  A group holds up to {PERSONAL_GROUP_MAX_MEMBERS} bots
                </span>
              ) : null}
            </span>
          </button>
        </li>
      </ul>
      {error !== null ? (
        <p
          role="alert"
          className="mt-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
        >
          {error}
        </p>
      ) : null}
      <p className="mt-2.5 px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
        {shownIds.some((botId) => {
          const bot = botsById.get(botId);
          return bot !== undefined && isGroupOnlyBot(bot);
        })
          ? "Bots that are only in groups stay out of your Bots list. Message one privately and it shows up there too."
          : "Each member keeps its own chat and memory."}
      </p>
    </section>
  );
}

/**
 * A group's settings, as a bottom sheet over the conversation: the one place a
 * bot that lives only in groups is reached from.
 */
export function GroupSettingsSheet({
  group,
  groups,
  bots,
  actions,
  onClose,
}: {
  readonly group: PersonalGroup;
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly actions: GroupMembersActions;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="bottom"
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-background/70 backdrop-blur-md"
        className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-bg)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
              {group.name}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              Group settings
            </SheetDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mt-1.5 -mr-2 h-11 shrink-0 rounded-[var(--personal-radius-button)] px-3 text-[15px] font-semibold text-[var(--personal-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            Done
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-5">
          <GroupMembersPanel group={group} groups={groups} bots={bots} actions={actions} />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
