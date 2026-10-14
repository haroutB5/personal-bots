/**
 * The DeepSeek (and xAI) API key field, end to end at the module boundary.
 *
 * Lives under `features/personal` because the fork's web gate runs
 * `vp test run --project unit src/features/personal` (the app sheet's gate);
 * the modules under test are `components/settings/providerApiKeys.ts` and
 * `components/settings/ProviderApiKeyRow.tsx`.
 */
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironmentVariable,
  type ServerProvider,
  type ServerProviderUsageBalance,
} from "@t3tools/contracts";

import {
  hasSavedProviderApiKey,
  providerApiKeyCheckLine,
  providerApiKeyField,
  withProviderApiKey,
  withoutProviderApiKey,
} from "../../components/settings/providerApiKeys";
import { ProviderApiKeyRow } from "../../components/settings/ProviderApiKeyRow";
import { getProviderSummary } from "../../components/settings/providerStatus";

const deepSeekField = providerApiKeyField("deepseek")!;

const savedKey: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
  { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true },
];
const otherVariables: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
  { name: "ANTHROPIC_BASE_URL", value: "https://example.test", sensitive: false },
];

function balance(overrides: Partial<ServerProviderUsageBalance> = {}): ServerProviderUsageBalance {
  return {
    checkedAt: "2026-10-14T10:00:00.000Z",
    status: "ready",
    balance: {
      currency: "USD",
      totalBalance: 12.34,
      grantedBalance: 2,
      toppedUpBalance: 10.34,
      isAvailable: true,
      fetchedAt: "2026-10-14T09:59:59.000Z",
    },
    ...overrides,
  };
}

const savedAtMs = Date.parse("2026-10-14T09:59:00.000Z");

describe("provider API key entries", () => {
  it("reads a redacted entry as saved and an absent one as unsaved", () => {
    expect(hasSavedProviderApiKey(savedKey, deepSeekField)).toBe(true);
    expect(hasSavedProviderApiKey(otherVariables, deepSeekField)).toBe(false);
  });

  it("writes the same sensitive entry the hand-typed setup used, keeping other variables", () => {
    const next = withProviderApiKey(otherVariables, deepSeekField, "sk-new-key");
    expect(next).toEqual([
      ...otherVariables,
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-new-key", sensitive: true },
    ]);
  });

  it("replaces a saved key instead of adding a second entry", () => {
    const next = withProviderApiKey([...otherVariables, ...savedKey], deepSeekField, "sk-second");
    expect(next.filter((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")).toEqual([
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-second", sensitive: true },
    ]);
  });

  it("removes only its own entry", () => {
    expect(withoutProviderApiKey([...otherVariables, ...savedKey], deepSeekField)).toEqual(
      otherVariables,
    );
  });
});

describe("providerApiKeyCheckLine", () => {
  it("says nothing before a key is saved in this session", () => {
    expect(
      providerApiKeyCheckLine({
        field: deepSeekField,
        balance: balance(),
        savedAtMs: null,
        enabled: true,
      }),
    ).toBeNull();
  });

  it("waits for a reading newer than the save", () => {
    expect(
      providerApiKeyCheckLine({
        field: deepSeekField,
        balance: balance({ checkedAt: "2026-10-14T09:58:00.000Z" }),
        savedAtMs,
        enabled: true,
      }),
    ).toEqual({ tone: "pending", text: "Checking this key…" });
  });

  it("reports a working key with the balance it read", () => {
    expect(
      providerApiKeyCheckLine({
        field: deepSeekField,
        balance: balance(),
        savedAtMs,
        enabled: true,
      }),
    ).toEqual({ tone: "ok", text: "Key works · balance $12.34" });
  });

  it("names a rejected key only for 401/403, never for a rate limit or an outage", () => {
    expect(
      providerApiKeyCheckLine({
        field: deepSeekField,
        balance: balance({
          status: "failed",
          failureReason: "auth_error",
          message: "DeepSeek did not accept this key, so it would not return the balance.",
        }),
        savedAtMs,
        enabled: true,
      }),
    ).toEqual({ tone: "rejected", text: "DeepSeek didn't accept this key" });

    // A rate limit, a server fault or a flaky network is not the key's fault,
    // and must not read as if it were.
    for (const failureReason of [
      "http_error",
      "network_error",
      "timeout",
      "invalid_response",
    ] as const) {
      expect(
        providerApiKeyCheckLine({
          field: deepSeekField,
          balance: balance({ status: "failed", failureReason, message: "…" }),
          savedAtMs,
          enabled: true,
        }),
      ).toEqual({ tone: "quiet", text: "Could not check the key right now" });
    }
  });

  it("calls a working key on an empty account a balance problem, with a way to top up", () => {
    expect(
      providerApiKeyCheckLine({
        field: deepSeekField,
        balance: balance({
          status: "failed",
          failureReason: "insufficient_balance",
          message: "This key works; the DeepSeek account has no credit left.",
        }),
        savedAtMs,
        enabled: true,
      }),
    ).toEqual({
      tone: "empty",
      text: "Key works, but your DeepSeek balance is empty",
      topUpUrl: "https://platform.deepseek.com/top_up",
    });
  });

  it("checks nothing for a provider with no balance endpoint", () => {
    expect(
      providerApiKeyCheckLine({
        field: providerApiKeyField("grok")!,
        balance: balance(),
        savedAtMs,
        enabled: true,
      }),
    ).toBeNull();
  });
});

describe("the DeepSeek card's status", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("deepseek"),
    driver: ProviderDriverKind.make("deepseek"),
    enabled: true,
    installed: true,
    version: null,
    status: "warning",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-14T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    message: "Set it in this instance's settings. Keys come from platform.deepseek.com.",
  };

  it("asks for the key instead of reporting an authentication failure", () => {
    expect(getProviderSummary(provider)).toEqual({
      headline: "Add your DeepSeek API key",
      detail: "Set it in this instance's settings. Keys come from platform.deepseek.com.",
    });
  });

  it("leaves a provider that also accepts a login alone", () => {
    expect(
      getProviderSummary({
        ...provider,
        driver: ProviderDriverKind.make("grok"),
        message: "Grok CLI is installed but not logged in. Run `grok login`.",
      }).headline,
    ).toBe("Not authenticated");
  });
});

describe("ProviderApiKeyRow", () => {
  const render = (props: {
    readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    readonly balance?: ServerProviderUsageBalance | undefined;
  }) =>
    renderToStaticMarkup(
      createElement(ProviderApiKeyRow, {
        driver: "deepseek",
        instanceId: "deepseek",
        enabled: true,
        environment: props.environment,
        balance: props.balance,
        readOnly: false,
        onChange: () => undefined,
      }),
    );

  it("opens a focused password field when no key is saved", () => {
    const markup = render({ environment: otherVariables });
    expect(markup).toContain('type="password"');
    expect(markup).toContain("autofocus");
    // Chromium may still offer to save a pasted key; `new-password` is the
    // spelling it honours, so the browser's password manager stays out of it.
    // Compared case-insensitively: the field renders the prop verbatim and HTML
    // attribute names are case-insensitive.
    expect(markup.toLowerCase()).toContain('autocomplete="new-password"');
    expect(markup).toContain("Add your DeepSeek API key.");
    expect(markup).toContain("https://platform.deepseek.com/api_keys");
    // Show is off by default, so the field offers Show and not Hide.
    expect(markup).toContain("Show");
    expect(markup).not.toContain(">Hide<");
  });

  it("shows only that a key is saved, with Replace and Remove, and never the value", () => {
    const markup = render({ environment: savedKey });
    expect(markup).toContain("Saved.");
    expect(markup).toContain("Replace");
    expect(markup).toContain("Remove");
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("leaves an optional key closed behind Add key until it is asked for", () => {
    // Grok also accepts `grok login`, so its field must not open by itself.
    const markup = renderToStaticMarkup(
      createElement(ProviderApiKeyRow, {
        driver: "grok",
        instanceId: "grok",
        enabled: true,
        environment: [],
        balance: undefined,
        readOnly: false,
        onChange: () => undefined,
      }),
    );
    expect(markup).toContain("Add key");
    expect(markup).toContain("xAI API key");
    expect(markup).not.toContain('type="password"');
  });

  it("claims nothing about a key it did not just check", () => {
    // A key saved on an earlier visit has no reading from this session, so the
    // row stays quiet rather than showing a balance that may be hours old.
    const markup = render({ environment: savedKey, balance: balance() });
    expect(markup).toContain("Saved.");
    expect(markup).not.toContain("Key works");
  });
});
