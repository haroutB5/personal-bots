import { createFileRoute } from "@tanstack/react-router";

import { AddProviderScreen } from "~/features/personal/providers/AddProviderScreen";
import type { CatalogFilter } from "~/features/personal/providers/catalogModel";

function readFilter(value: unknown): CatalogFilter | undefined {
  return value === "all" || value === "subscription" || value === "apiKey" || value === "free"
    ? value
    : undefined;
}

export const Route = createFileRoute("/_personal/bots_/settings_/providers/add")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { q?: string; f?: CatalogFilter; return?: string } => {
    const q = typeof search.q === "string" ? search.q : undefined;
    const f = readFilter(search.f);
    const returnTarget = typeof search.return === "string" ? search.return : undefined;
    return {
      ...(q !== undefined ? { q } : {}),
      ...(f !== undefined ? { f } : {}),
      ...(returnTarget !== undefined ? { return: returnTarget } : {}),
    };
  },
  component: AddProviderScreen,
});
