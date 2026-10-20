import type { JSX } from "react";
import { useMemo } from "react";

import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { primaryServerProvidersAtom } from "~/state/server";

import { buildProviderList } from "../providerRows";
import { usePersonalBotsList, usePersonalEnvironmentId } from "../usePersonalBots";
import { providerFacts } from "./providerFacts";
import { useProviderInstallStates } from "./providerInstallStates";
import { CARD, ProviderTile } from "./providerUi";

/**
 * Add provider (release 1): the built-in providers that are not installed and
 * not used by a bot, each opening its provider page. The catalogue of every
 * ACP registry agent, search and filters arrive in release 2.
 */
export function AddProviderScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const bots = usePersonalBotsList(environmentId).data?.bots ?? [];
  const { installs, watchers } = useProviderInstallStates(environmentId, providers);
  const { addable } = useMemo(
    () => buildProviderList(providers, bots, installs),
    [providers, bots, installs],
  );
  return (
    <div className="flex flex-col px-5 pb-8">
      {watchers}
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          activeOptions={{ exact: true }}
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="min-w-0 flex-1 text-[19px] font-bold text-[var(--personal-text)]">
          Add provider
        </h1>
      </header>
      {addable.length === 0 ? (
        <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
          Every provider hbots knows is already in your list.
        </p>
      ) : (
        <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
          {addable.map((row) => {
            const facts = providerFacts(row.driver);
            return (
              <li key={row.instanceId}>
                <Link
                  to="/bots/settings/providers/$instanceId"
                  params={{ instanceId: row.instanceId }}
                  className="flex min-h-16 items-center gap-3 px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
                >
                  <ProviderTile driver={row.driver} label={row.label} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                        {row.label}
                      </span>
                      <span className="shrink-0 rounded-full border border-[var(--personal-border-strong)] px-1.5 text-[11px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
                        Built in
                      </span>
                    </span>
                    {facts !== null ? (
                      <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                        {facts.publisher}
                        {facts.cost !== null ? ` · ${facts.cost.label}` : ""}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                    strokeWidth={1.75}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
        Built in providers are made and tested for hbots. More providers from the ACP registry, an
        open list of coding agents, come in a later update.
      </p>
    </div>
  );
}
