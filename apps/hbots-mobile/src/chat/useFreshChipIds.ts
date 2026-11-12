import { useState } from "react";

import { freshChipIds } from "./chipMotion";

interface Seen {
  readonly key: string;
  readonly known: ReadonlySet<string> | null;
  readonly fresh: ReadonlySet<string>;
}

export function useFreshChipIds(ids: ReadonlyArray<string>): ReadonlySet<string> {
  const key = ids.join("|");
  const [seen, setSeen] = useState<Seen>({ key: "\u0000", known: null, fresh: new Set() });
  if (seen.key === key) return seen.fresh;
  const next = {
    key,
    known: new Set([...(seen.known ?? []), ...ids]),
    fresh: freshChipIds(seen.known, ids),
  };
  setSeen(next);
  return next.fresh;
}
