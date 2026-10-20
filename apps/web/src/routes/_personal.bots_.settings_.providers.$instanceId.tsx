import { createFileRoute } from "@tanstack/react-router";

import {
  ProviderPageScreen,
  type ProviderPageAction,
} from "~/features/personal/providers/ProviderPage";

function readAction(value: unknown): ProviderPageAction | undefined {
  return value === "install" || value === "signIn" || value === "fix" ? value : undefined;
}

export const Route = createFileRoute("/_personal/bots_/settings_/providers/$instanceId")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { action?: ProviderPageAction; return?: string } => {
    const action = readAction(search.action);
    const returnTarget = typeof search.return === "string" ? search.return : undefined;
    return {
      ...(action !== undefined ? { action } : {}),
      ...(returnTarget !== undefined ? { return: returnTarget } : {}),
    };
  },
  component: ProviderPageRoute,
});

function ProviderPageRoute() {
  const { instanceId } = Route.useParams();
  const { action, return: returnTarget } = Route.useSearch();
  return <ProviderPageScreen instanceId={instanceId} action={action} returnTarget={returnTarget} />;
}
