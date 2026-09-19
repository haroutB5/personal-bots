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
  Info,
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
import {
  type PersonalPreference,
  setPersonalPreference,
  usePersonalPreference,
} from "./personalPreferences";
import {
  PERSONAL_THEME_MODE_LABELS,
  PERSONAL_THEME_MODES,
  usePersonalTheme,
} from "./personalTheme";
import { useAppVersion } from "./appVersion";
import { PersonalProviderRows } from "./PersonalProviderRows";
import { buildProviderUpdateRows } from "./providerUpdateRows";

const SECTION_TITLE =
  "mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase";
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
        <p
          id="personal-display-name-error"
          role="alert"
          className="mt-1.5 text-sm text-[var(--personal-error)]"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

/** A device-local on/off row, styled like the Diagnostics toggle below it. */
function PreferenceRow({
  preference,
  label,
  hint,
}: {
  preference: PersonalPreference;
  label: string;
  hint: string;
}): JSX.Element {
  const enabled = usePersonalPreference(preference);
  return (
    <button
      type="button"
      onClick={() => setPersonalPreference(preference, !enabled)}
      aria-pressed={enabled}
      className={`${SETTINGS_ROW} w-full text-left`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold text-[var(--personal-text)]">{label}</span>
        <span className="text-[13px] text-[var(--personal-text-secondary)]">{hint}</span>
      </span>
      <span className="shrink-0 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

/**
 * System / Light / Dark. A segmented radiogroup rather than the On/Off
 * `PreferenceRow` next door, because three states do not collapse to a toggle
 * and the current one has to be readable without tapping.
 *
 * Native radios are skipped for the same reason the rest of this screen skips
 * them (the visual is a filled pill, not a dot), so the roles are declared:
 * `role="radiogroup"` on the strip, `role="radio"` + `aria-checked` on each
 * segment. Roving tabindex keeps it to one tab stop, matching how VoiceOver
 * and a keyboard both expect a radio group to behave.
 */
function AppearanceControl(): JSX.Element {
  const { mode, setMode } = usePersonalTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex gap-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] p-1"
    >
      {PERSONAL_THEME_MODES.map((candidate) => {
        const selected = candidate === mode;
        return (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setMode(candidate)}
            className={`min-h-11 flex-1 rounded-[calc(var(--personal-radius-button)-2px)] text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] ${
              selected
                ? "bg-[var(--personal-primary)] font-semibold text-[var(--personal-primary-text)]"
                : "text-[var(--personal-text-secondary)]"
            }`}
          >
            {PERSONAL_THEME_MODE_LABELS[candidate]}
          </button>
        );
      })}
    </div>
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
  const { label: versionLabel, updateAvailable } = useAppVersion();
  const versionNumber = versionLabel?.replace(/^v/, "") ?? null;
  const bots = useMemo(
    () => (list.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [list.data],
  );

  const providerRows = useMemo(() => buildProviderUpdateRows(providers, bots), [providers, bots]);

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
          How your bots address you, and your name on the Team screen.
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
          {/*
            The bot list itself is not repeated here: the Chats screen already
            lists every bot, and tapping a chat's header avatar opens the same
            editor. Two lists of the same thing is one to keep in sync.
          */}
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

      {environmentId !== null && providerRows.length > 0 ? (
        <section aria-labelledby="settings-providers">
          <h2 id="settings-providers" className={SECTION_TITLE}>
            Providers
          </h2>
          <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
            <PersonalProviderRows environmentId={environmentId} rows={providerRows} />
          </ul>
          <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
            After an update, each bot switches to the new version once its current reply ends.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="settings-appearance">
        <h2 id="settings-appearance" className={SECTION_TITLE}>
          Appearance
        </h2>
        <div className={`${CARD} p-3`}>
          <AppearanceControl />
        </div>
        <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
          System follows your phone&apos;s Light/Dark setting.
        </p>
      </section>

      <section aria-labelledby="settings-chat">
        <h2 id="settings-chat" className={SECTION_TITLE}>
          Chat
        </h2>
        <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
          <li>
            <PreferenceRow
              preference="showToolSteps"
              label="Show tool steps"
              hint='The collapsed "2 steps" rows showing what a bot did between replies.'
            />
          </li>
          <li>
            <PreferenceRow
              preference="showRoutinesStrip"
              label="Show routines in chats"
              hint="The Routines strip under a chat, listing that bot's scheduled work."
            />
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
                  Saved website logins and bot grants
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

      <section aria-labelledby="settings-about">
        <h2 id="settings-about" className={SECTION_TITLE}>
          About
        </h2>
        {updateAvailable && versionLabel !== null ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            aria-label={`Update to ${versionLabel} - tap to refresh`}
            className={`${CARD} ${SETTINGS_ROW} w-full text-left`}
          >
            <Info
              aria-hidden="true"
              className="size-5 shrink-0 text-[var(--personal-text)]"
              strokeWidth={1.75}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold text-[var(--personal-text)]">About</span>
              <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                Version {versionNumber} · Update available
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-semibold text-[var(--personal-primary)]">
              Update
            </span>
          </button>
        ) : (
          <div className={`${CARD} ${SETTINGS_ROW}`}>
            <Info
              aria-hidden="true"
              className="size-5 shrink-0 text-[var(--personal-text)]"
              strokeWidth={1.75}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold text-[var(--personal-text)]">About</span>
              <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                {versionNumber === null ? "Development build" : `Version ${versionNumber}`}
              </span>
            </span>
          </div>
        )}
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
