import { createFileRoute } from "@tanstack/react-router";

import { CatalogProviderPageScreen } from "~/features/personal/providers/CatalogProviderPage";

export const Route = createFileRoute("/_personal/bots_/settings_/providers/catalog/$catalogId")({
  validateSearch: (search: Record<string, unknown>): { return?: string } => {
    const returnTarget = typeof search.return === "string" ? search.return : undefined;
    return returnTarget !== undefined ? { return: returnTarget } : {};
  },
  component: CatalogProviderPageRoute,
});

function CatalogProviderPageRoute() {
  const { catalogId } = Route.useParams();
  const { return: returnTarget } = Route.useSearch();
  return <CatalogProviderPageScreen catalogId={catalogId} returnTarget={returnTarget} />;
}
