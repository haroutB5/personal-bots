import { createFileRoute } from "@tanstack/react-router";

import {
  ProviderPageScreen,
  type ProviderPageAction,
} from "~/features/personal/providers/ProviderPage";

function readAction(value: unknown): ProviderPageAction | undefined {
  return value === "install" || value === "signIn" || value === "fix" ? value : undefined;
}

export const Route = createFileRoute("/_personal/bots_/settings_/providers/$instanceId")({
  validateSearch: (search: Record<string, unknown>): { action?: ProviderPageAction } => {
    const action = readAction(search.action);
    return action === undefined ? {} : { action };
  },
  component: ProviderPageRoute,
});

function ProviderPageRoute() {
  const { instanceId } = Route.useParams();
  const { action } = Route.useSearch();
  return <ProviderPageScreen instanceId={instanceId} action={action} />;
}
