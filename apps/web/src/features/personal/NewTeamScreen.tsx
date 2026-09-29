import type { JSX } from "react";

import { useNavigate } from "@tanstack/react-router";

import { PersonalPageHeader } from "./BotForm";
import { NewTeamForm } from "./NewTeamForm";
import { setTeamNotice } from "./teamNotice";
import {
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";

/**
 * /bots/teams/new — the "+" menu's New team. A name, an optional leader and
 * optional first members; on success it lands on the team diagram, which says
 * what happened.
 */
export function NewTeamScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const navigate = useNavigate();
  const list = usePersonalBotsList(environmentId);
  const profile = usePersonalProfile(environmentId);

  return (
    <div className="px-5">
      <PersonalPageHeader title="New team" />
      {environmentId === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          Connect to your computer to create a team.
        </p>
      ) : list.data === null || profile.data === null ? (
        <p role="status" className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          {list.error !== null || profile.error !== null
            ? "Couldn't load your bots and teams."
            : "Loading your bots…"}
        </p>
      ) : (
        <div className="mt-2">
          <NewTeamForm
            environmentId={environmentId}
            bots={list.data.bots}
            customTeams={profile.data.customTeams ?? []}
            onCreated={(notice) => {
              setTeamNotice(notice);
              void navigate({ to: "/bots/team", replace: true });
            }}
          />
        </div>
      )}
    </div>
  );
}
