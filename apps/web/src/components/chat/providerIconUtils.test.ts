import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

it("maps each provider driver to an icon component", () => {
  const kinds = ["codex", "claudeAgent", "antigravity"] as const;
  for (const kind of kinds) {
    expect(typeof PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(kind)]).toBe("function");
  }
});
