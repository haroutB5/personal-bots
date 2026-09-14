import type { FormEvent, JSX } from "react";
import { cloneElement, useMemo, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Brain,
  CalendarClock,
  ChevronRight,
  KeyRound,
  Network,
  SquareTerminal,
} from "lucide-react";

import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { PersonalPageHeader } from "./BotForm";
import { providerLine, resolveBotProvider } from "./botSummaries";
import { commandFailureMessage } from "./commandFeedback";
import { setDeveloperView } from "./personalMode";
import {
  personalProfileSet,
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "./DiagnosticsOverlay";

const SECTION_TITLE =
  "mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase";
const CARD =
  "overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";
const SETTINGS_ROW =
  "flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";

function DisplayNameForm({
  environmentId,
  initialName,
}: {
  environmentId: EnvironmentId;
  initialName: string;
}): JSX.Element {
  const setProfile = useAtomCommand(personalProfileSet);
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [busy, setBusy] = useState(false);
  // A save that never lands used to leave nothing behind but a console
  // warning: the field kept the typed name, so it looked saved.
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== saved.trim();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    const result = await setProfile({ environmentId, input: { displayName: name } });
    setBusy(false);
    const failure = commandFailureMessage(result, "Couldn't save your name. Try again.");
    setError(failure);
    if (failure === null && result._tag === "Success") {
      setSaved(result.value.displayName);
      setName(result.value.displayName);
    }
  };

  return (
    <>
      <form
        onSubmit={(event) => void onSubmit(event)}
        className={`${CARD} flex items-center gap-2 p-2`}
      >
        <label htmlFor="personal-display-name" className="sr-only">
          Your name
        </label>
        <input
          id="personal-display-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your name"
          autoComplete="given-name"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? "personal-display-name-error" : undefined}
          className="h-11 min-w-0 flex-1 rounded-[var(--personal-radius-button)] bg-transparent px-2 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        />
        <button
          type="submit"
          disabled={!dirty || busy}
          aria-busy={busy}
          className="h-11 shrink-0 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-40"
        >
          Save
        </button>
      </form>
      {error !== null ? (
        <p id="personal-display-name-error" role="alert" className="mt-1.5 text-sm text-[#b3261e]">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** /bots/settings: greeting name, bot management and the Developer view exit. */
export function PersonalSettingsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [diagnosticsOn, setDiagnosticsOn] = useState(() => diagnosticsEnabled());
  const environmentId = usePersonalEnvironmentId();
  const profile = usePersonalProfile(environmentId);
  const list = usePersonalBotsList(environmentId);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const bots = useMemo(
    () => (list.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [list.data],
  );

  const openDeveloperView = () => {
    setDeveloperView(true);
    void navigate({ to: "/" });
  };

  return (
    <div className="flex flex-col gap-7 px-5 pb-8">
      <PersonalPageHeader title="Settings" />

      <section aria-labelledby="settings-name">
        <h2 id="settings-name" className={SECTION_TITLE}>
          Your name
        </h2>
        {environmentId !== null && profile.data !== null ? (
          <DisplayNameForm
            key={profile.data.displayName}
            environmentId={environmentId}
            initialName={profile.data.displayName}
          />
        ) : null}
        <p className="mt-2 px-1 text-sm text-[var(--personal-text-secondary)]">
          Used in the greeting on the Chats screen.
        </p>
      </section>

      <section aria-labelledby="settings-bots">
        <h2 id="settings-bots" className={SECTION_TITLE}>
          Bots
        </h2>
        <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
          <li>
            <Link to="/bots/team" className={SETTINGS_ROW}>
              <Network
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text)]"
                strokeWidth={1.75}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold text-[var(--personal-text)]">Team</span>
                <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                  See how your bots work together
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                strokeWidth={1.75}
              />
            </Link>
          </li>
          {bots.map((bot) => (
            <li key={bot.botId}>
              <Link
                to="/bots/$botId/edit"
                params={{ botId: bot.botId }}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
              >
                <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label="" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-semibold text-[var(--personal-text)]">
                    {bot.name}
                  </span>
                  <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                    {providerLine(resolveBotProvider(bot.modelSelection.instanceId, providers))}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                  strokeWidth={1.75}
                />
              </Link>
            </li>
          ))}
          <li>
            <Link
              to="/bots/new"
              className="flex min-h-12 items-center px-4 text-[15px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              New bot
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="settings-plugins">
        <h2 id="settings-plugins" className={SECTION_TITLE}>
          Plugins
        </h2>
        <ul className={CARD}>
          <li>
            <Link to="/bots/settings/passwords" className={SETTINGS_ROW}>
              <KeyRound
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text)]"
                strokeWidth={1.75}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold text-[var(--personal-text)]">
                  Passwords
                </span>
                <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                  Logins bots can use without seeing passwords
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                strokeWidth={1.75}
              />
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="settings-automation">
        <h2 id="settings-automation" className={SECTION_TITLE}>
          Routines, memory and notifications
        </h2>
        <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
          {(
            [
              {
                key: "routines",
                icon: CalendarClock,
                label: "Routines",
                hint: "Scheduled work for your bots",
                link: <Link to="/tasks" search={{ view: "scheduled" }} className={SETTINGS_ROW} />,
              },
              {
                key: "memory",
                icon: Brain,
                label: "Memory",
                hint: "What bots remember, and deleting it",
                link: <Link to="/bots/settings/memory" className={SETTINGS_ROW} />,
              },
              {
                key: "notifications",
                icon: Bell,
                label: "Notifications",
                hint: "Alerts on this phone when bots finish or need you",
                link: <Link to="/bots/settings/notifications" className={SETTINGS_ROW} />,
              },
            ] as const
          ).map((entry) => (
            <li key={entry.key}>
              {cloneElement(
                entry.link,
                undefined,
                <>
                  <entry.icon
                    aria-hidden="true"
                    className="size-5 shrink-0 text-[var(--personal-text)]"
                    strokeWidth={1.75}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold text-[var(--personal-text)]">
                      {entry.label}
                    </span>
                    <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                      {entry.hint}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                    strokeWidth={1.75}
                  />
                </>,
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="settings-developer">
        <h2 id="settings-developer" className={SECTION_TITLE}>
          Advanced
        </h2>
        <button
          type="button"
          onClick={openDeveloperView}
          className={`${CARD} flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]`}
        >
          <SquareTerminal
            aria-hidden="true"
            className="size-5 shrink-0 text-[var(--personal-text)]"
            strokeWidth={1.75}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold text-[var(--personal-text)]">
              Developer view
            </span>
            <span className="text-[13px] text-[var(--personal-text-secondary)]">
              The full T3 Code workspace. Use "Bots" in its sidebar to come back.
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
            strokeWidth={1.75}
          />
        </button>
        <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
          Bots only use their built-in tools and this app&apos;s tools. Your Claude Code add-ons and
          claude.ai connectors, and your Codex plugins and connectors, are not shared with bots.
        </p>
        <button
          type="button"
          onClick={() => {
            setDiagnosticsEnabled(!diagnosticsOn);
            setDiagnosticsOn(!diagnosticsOn);
          }}
          aria-pressed={diagnosticsOn}
          className={`${CARD} mt-3 flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]`}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold text-[var(--personal-text)]">
              Diagnostics overlay
            </span>
            <span className="text-[13px] text-[var(--personal-text-secondary)]">
              Shows live viewport numbers in chats, for debugging keyboard issues.
            </span>
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
            {diagnosticsOn ? "On" : "Off"}
          </span>
        </button>
      </section>
    </div>
  );
}
