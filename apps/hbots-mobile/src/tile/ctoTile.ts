import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";

import { ctoTileLink } from "./ctoTarget";

interface TileModule {
  setCtoLink(link: string | null): void;
}

const native = requireOptionalNativeModule<TileModule>("HbotsTile");

/**
 * Keeps the Quick Settings tile pointed at the CTO bot. With no CTO bot the
 * link clears, and the tile falls back to the alias the app answers.
 */
export function useCtoTilePublisher(
  bots: ReadonlyArray<Parameters<typeof ctoTileLink>[0][number]> | null,
): void {
  const link = bots === null ? undefined : ctoTileLink(bots);
  useEffect(() => {
    if (link === undefined) return;
    native?.setCtoLink(link);
  }, [link]);
}
