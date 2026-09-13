import type { FormEvent, JSX } from "react";
import { useMemo, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, SquareTerminal } from "lucide-react";

import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { PersonalPageHeader } from "./BotForm";
import { providerLine, resolveBotProvider } from "./botSummaries";
import { setDeveloperView } from "./personalMode";
import {
  personalProfileSet,
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";

const SECTION_TITLE =
  "mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase";
const CARD =
  "overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";

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
  const dirty = name.trim() !== saved.trim();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    const result = await setProfile({ environmentId, input: { displayName: name } });
    setBusy(false);
    if (result._tag === "Success") {
      setSaved(result.value.displayName);
      setName(result.value.displayName);
    }
  };

  return (
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
  );
}

/** /bots/settings: greeting name, bot management and the Developer view exit. */
export function PersonalSettingsScreen(): JSX.Element {
  const navigate = useNavigate();
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
      </section>
    </div>
  );
}
