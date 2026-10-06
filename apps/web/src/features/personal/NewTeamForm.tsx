import type { FormEvent, JSX } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import {
  botTeam,
  isGroupOnlyBot,
  isTeamLead,
  personalBotTeamLabel,
  type EnvironmentId,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { botActiveModelShortLabel } from "./botModelLabel";
import { commandFailureMessage } from "./commandFeedback";
import {
  leaderMoveWarning,
  leadersLeaving,
  planTeamMoves,
  teamCreatedMessage,
  teamNameProblem,
  TEAM_NAME_MAX,
} from "./newTeamModel";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import type { TeamNotice } from "./teamNotice";
import { personalBotUpdate, personalProfileSet } from "./usePersonalBots";

const FIELD_CLASS =
  "h-11 w-full rounded-[var(--personal-radius-button)] border bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LIST_CLASS =
  "divide-y divide-[var(--personal-border)] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)]";
const PRIMARY_BUTTON =
  "h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40";
const SECONDARY_BUTTON =
  "h-11 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

function BotOption({
  bot,
  modelLabel,
}: {
  readonly bot: PersonalBot;
  readonly modelLabel: string | null;
}): JSX.Element {
  const leads = isTeamLead(bot);
  return (
    <>
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label="" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-[var(--personal-text)]">
          {bot.name}
        </span>
        {modelLabel !== null ? (
          <span className="block truncate text-[13px] text-[var(--personal-text-secondary)]">
            {modelLabel}
          </span>
        ) : null}
        {leads ? (
          <span className="block truncate text-[13px] text-[var(--personal-review-text)]">
            Leads {personalBotTeamLabel(botTeam(bot))}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * A team's name, an optional leader and optional first members, in one step.
 * Shared by the New team screen (the "+" menu on Bots) and the team diagram.
 *
 * The team is registered through `personalProfile.set` and the bots are then
 * moved with `personalBots.update`, the very calls the team diagram's drag and
 * the bot form make, so the server's rules (a known team, one lead per team)
 * are the only rules. A bot that leads another team is named first and moved
 * only after a second, explicit confirm: its old team is left without a lead.
 */
export function NewTeamForm({
  environmentId,
  bots: allBots,
  customTeams,
  onCreated,
  onCancel,
  initialMemberIds = [],
}: {
  /** Members ticked from the start ("New team with Frontend" on the Team screen). */
  readonly initialMemberIds?: ReadonlyArray<string>;
  readonly environmentId: EnvironmentId | null;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
  /** Called with the sentence to announce once the team and every move are done. */
  readonly onCreated: (notice: TeamNotice) => void;
  readonly onCancel?: () => void;
}): JSX.Element {
  const formId = useId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const saveProfile = useAtomCommand(personalProfileSet, { reportFailure: false });
  const updateBot = useAtomCommand(personalBotUpdate, { reportFailure: false });
  const offline = useLaptopOffline();
  const [name, setName] = useState("");
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<ReadonlyArray<string>>(initialMemberIds);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Set once the team exists, so a retry after a failed move does not try to
  // register it a second time; the bots already moved are not moved again.
  const [createdName, setCreatedName] = useState<string | null>(null);
  const moved = useRef(new Set<string>());
  const nameRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const bots = useMemo(() => allBots.filter((bot) => !isGroupOnlyBot(bot)), [allBots]);
  const labels = useMemo(
    () => new Map(bots.map((bot) => [bot.botId, botActiveModelShortLabel(bot, providers)])),
    [bots, providers],
  );
  const leader = bots.find((bot) => bot.botId === leaderId) ?? null;
  const members = bots.filter((bot) => memberIds.includes(bot.botId) && bot.botId !== leaderId);
  const leaving = leadersLeaving([...(leader === null ? [] : [leader]), ...members]);
  const teamName = name.trim();
  const warning = leaving.length === 0 ? null : leaderMoveWarning(leaving, teamName);
  const disabled = busy || offline || environmentId === null;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const create = async () => {
    if (environmentId === null) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      let team = createdName;
      if (team === null) {
        const result = await saveProfile({
          environmentId,
          input: { teamChange: { operation: "create", name: teamName } },
        });
        const failure = commandFailureMessage(result, "Couldn't create the team. Try again.");
        if (failure !== null) {
          setError(failure);
          return;
        }
        team = teamName;
        setCreatedName(teamName);
      }
      for (const move of planTeamMoves({ leader, members, team })) {
        if (moved.current.has(move.botId)) continue;
        const result = await updateBot({
          environmentId,
          input: { botId: move.botId, team, lead: move.lead },
        });
        const failure = commandFailureMessage(result, `${move.name} couldn't be moved.`);
        if (failure !== null) {
          setError(`${team} was created, but ${move.name} couldn't be moved: ${failure}`);
          return;
        }
        moved.current.add(move.botId);
      }
      onCreated({
        team,
        message: teamCreatedMessage({
          team,
          leaderName: leader?.name ?? null,
          memberCount: members.length,
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    if (createdName === null) {
      const problem = teamNameProblem(name, customTeams, allBots);
      setNameError(problem);
      if (problem !== null) {
        nameRef.current?.focus();
        return;
      }
    }
    if (warning !== null && !confirming && createdName === null) {
      setConfirming(true);
      return;
    }
    void create();
  };

  const toggleMember = (bot: PersonalBot) => {
    setError(null);
    setConfirming(false);
    setMemberIds((current) =>
      current.includes(bot.botId)
        ? current.filter((id) => id !== bot.botId)
        : [...current, bot.botId],
    );
  };

  const leaderName = leader?.name ?? null;
  const errorId = `${formId}-name-error`;

  return (
    <form
      onSubmit={onSubmit}
      aria-label="New team"
      className="flex flex-col gap-5"
      // A changed choice withdraws a confirm that was about the old one.
      onChange={() => setConfirming(false)}
    >
      <div>
        <label
          htmlFor={`${formId}-name`}
          className="mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
        >
          Team name
        </label>
        <input
          id={`${formId}-name`}
          ref={nameRef}
          value={name}
          onChange={(event) => {
            setName(event.target.value.slice(0, TEAM_NAME_MAX));
            setNameError(null);
          }}
          required
          disabled={busy || createdName !== null}
          placeholder="e.g. Research"
          aria-invalid={nameError !== null || undefined}
          aria-describedby={nameError !== null ? errorId : undefined}
          className={cn(
            FIELD_CLASS,
            nameError !== null
              ? "border-[var(--personal-error)]"
              : "border-[var(--personal-border-strong)]",
          )}
        />
        {nameError !== null ? (
          <p id={errorId} className="mt-1.5 text-[13px] text-[var(--personal-error)]">
            {nameError}
          </p>
        ) : null}
      </div>

      <fieldset className="min-w-0" disabled={busy}>
        <legend className="flex w-full items-baseline justify-between gap-2 pb-1.5">
          <span className="text-sm font-medium text-[var(--personal-text)]">Leader</span>
          <span className="text-sm text-[var(--personal-text-secondary)]">Optional</span>
        </legend>
        {bots.length === 0 ? (
          <p className="text-[15px] text-[var(--personal-text-secondary)]">
            No bots yet. The team can start empty.
          </p>
        ) : (
          <ul className={LIST_CLASS}>
            <li>
              <label className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3.5 py-2">
                <input
                  type="radio"
                  name={`${formId}-leader`}
                  checked={leaderId === null}
                  onChange={() => setLeaderId(null)}
                  className="size-5 shrink-0"
                />
                <span className="min-w-0 flex-1 text-[15px] text-[var(--personal-text)]">
                  No leader for now
                </span>
              </label>
            </li>
            {bots.map((bot) => (
              <li key={bot.botId}>
                <label className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3.5 py-2">
                  <input
                    type="radio"
                    name={`${formId}-leader`}
                    checked={leaderId === bot.botId}
                    onChange={() => setLeaderId(bot.botId)}
                    className="size-5 shrink-0"
                  />
                  <BotOption bot={bot} modelLabel={labels.get(bot.botId) ?? null} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {bots.length > 1 ? (
        <details className="min-w-0" open={members.length > 0 || undefined}>
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-medium text-[var(--personal-text)]">
            <span>Members</span>
            <span className="text-[var(--personal-text-secondary)]">
              {members.length === 0 ? "Optional" : `${String(members.length)} picked`}
            </span>
          </summary>
          <fieldset className="mt-1.5 min-w-0" disabled={busy}>
            <legend className="sr-only">Bots to move into the new team</legend>
            <ul className={LIST_CLASS}>
              {bots
                .filter((bot) => bot.botId !== leaderId)
                .map((bot) => (
                  <li key={bot.botId}>
                    <label className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3.5 py-2">
                      <input
                        type="checkbox"
                        checked={memberIds.includes(bot.botId)}
                        onChange={() => toggleMember(bot)}
                        className="size-5 shrink-0"
                      />
                      <BotOption bot={bot} modelLabel={labels.get(bot.botId) ?? null} />
                    </label>
                  </li>
                ))}
            </ul>
          </fieldset>
        </details>
      ) : null}

      {warning !== null ? (
        <p
          role="status"
          className="rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-4 py-2.5 text-[15px] leading-snug text-[var(--personal-text)]"
        >
          {warning}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
      {offline ? (
        <p className="text-sm text-[var(--personal-text-secondary)]">
          Your computer is offline. Try again once it reconnects.
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-5 flex flex-col gap-2 border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-5 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {confirming ? (
          <div role="group" aria-label="Confirm the move" className="flex flex-col gap-2">
            <p className="text-[15px] leading-snug font-medium text-[var(--personal-text)]">
              {warning}
            </p>
            <button
              ref={confirmRef}
              type="button"
              disabled={disabled}
              onClick={() => void create()}
              className={PRIMARY_BUTTON}
            >
              {leaving.length === 1
                ? `Move ${leaving[0]!.botName} and create team`
                : "Move them and create team"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={SECONDARY_BUTTON}>
              Back
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {onCancel === undefined ? null : (
              <button type="button" disabled={busy} onClick={onCancel} className={SECONDARY_BUTTON}>
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={disabled || (createdName === null && teamName.length === 0)}
              aria-busy={busy}
              className={cn(PRIMARY_BUTTON, "min-w-0 flex-1")}
            >
              {busy
                ? "Creating…"
                : createdName !== null
                  ? "Try again"
                  : leaderName === null
                    ? "Create team"
                    : `Create team, ${leaderName} leads`}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
