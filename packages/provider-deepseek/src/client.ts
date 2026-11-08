/**
 * DeepSeek's client definition: settings form, label, and key field.
 * Browser- and React Native-safe.
 *
 * @module provider-deepseek/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { DeepSeekSettings } from "./settings.ts";

export const deepSeekClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("deepseek"),
  label: "DeepSeek",
  settingsSchema: DeepSeekSettings,
  environmentFields: [
    {
      name: "ANTHROPIC_AUTH_TOKEN",
      label: "DeepSeek API key",
      description: "Keys come from platform.deepseek.com. Stored as this instance's environment.",
      placeholder: "sk-…",
      sensitive: true,
    },
  ],
});
