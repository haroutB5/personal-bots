import { SecretProviderId, type ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasSavedProviderApiKey, type ProviderApiKeyField } from "./providerApiKeys";

const field = { name: "XAI_API_KEY" } as ProviderApiKeyField;
const entry = (
  value: ProviderInstanceEnvironmentVariable["value"],
  valueRedacted?: true,
): ProviderInstanceEnvironmentVariable =>
  ({
    name: "XAI_API_KEY",
    value,
    sensitive: true,
    ...(valueRedacted === undefined ? {} : { valueRedacted }),
  }) as ProviderInstanceEnvironmentVariable;

describe("hasSavedProviderApiKey", () => {
  it("counts a key held in a secret manager as saved", () => {
    const reference = { provider: SecretProviderId.make("onepassword"), reference: "op://v/xai" };
    expect(hasSavedProviderApiKey([entry(reference)], field)).toBe(true);
  });

  it("counts a redacted or typed key as saved", () => {
    expect(hasSavedProviderApiKey([entry("", true)], field)).toBe(true);
    expect(hasSavedProviderApiKey([entry("xai-123")], field)).toBe(true);
  });

  it("reports no key when the entry is missing or blank", () => {
    expect(hasSavedProviderApiKey([], field)).toBe(false);
    expect(hasSavedProviderApiKey([entry("  ")], field)).toBe(false);
  });
});
