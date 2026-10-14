/**
 * API-key providers — the one field each of them needs, and the rules around it.
 *
 * Some providers authenticate with a key the owner pastes rather than a
 * browser login. Until this module existed the only way in was the generic
 * **Environment** row, where the owner had to know the variable's name
 * (`ANTHROPIC_AUTH_TOKEN`, `XAI_API_KEY`) and mark it sensitive by hand. Each
 * entry here turns that into a labelled, masked field that still writes the
 * same sensitive environment entry, so the server's redaction, encrypted
 * secret store and both DeepSeek engines are untouched.
 *
 * Nothing here ever holds a value from a saved entry: the server returns
 * sensitive values redacted (`valueRedacted`), and the field only ever reports
 * whether one is saved.
 *
 * @module components/settings/providerApiKeys
 */
import type {
  ProviderInstanceEnvironmentVariable,
  ServerProviderUsageBalance,
} from "@t3tools/contracts";

export interface ProviderApiKeyField {
  /** The environment entry the key is stored in. Unchanged from the hand-typed setup. */
  readonly name: string;
  /** Row label, shown as written. */
  readonly label: string;
  /** How the provider is named in a check result ("DeepSeek didn't accept this key"). */
  readonly displayName: string;
  /** Where the owner gets a key. */
  readonly keysUrl: string;
  /** The link text for {@link keysUrl}. */
  readonly keysUrlLabel: string;
  /** One line under the row while no key is saved. */
  readonly emptyDescription: string;
  /**
   * True when the key is the provider's only way in: a missing one opens the
   * field by itself and the card's status asks for it. False when a login also
   * works (Grok), where the field is offered but nothing opens unasked.
   */
  readonly required: boolean;
  /**
   * True when the provider publishes a reading that proves the key works
   * (DeepSeek's prepaid balance). False when saving is all there is to check.
   */
  readonly checkedWithBalance: boolean;
  readonly placeholder: string;
}

/**
 * One entry per driver that carries an API key in its instance environment.
 * Deliberately small: Claude Code, Codex, Cursor and Antigravity authenticate
 * through their own logins or their own settings schema, and OpenCode connects
 * upstream providers through `opencode auth login`, so none of them has a
 * single hand-typed key to replace.
 */
export const PROVIDER_API_KEY_FIELDS: Readonly<Record<string, ProviderApiKeyField>> = {
  deepseek: {
    name: "ANTHROPIC_AUTH_TOKEN",
    label: "DeepSeek API key",
    displayName: "DeepSeek",
    keysUrl: "https://platform.deepseek.com/api_keys",
    keysUrlLabel: "platform.deepseek.com",
    emptyDescription: "Add your DeepSeek API key.",
    required: true,
    checkedWithBalance: true,
    placeholder: "sk-…",
  },
  grok: {
    name: "XAI_API_KEY",
    label: "xAI API key",
    displayName: "xAI",
    keysUrl: "https://console.x.ai",
    keysUrlLabel: "console.x.ai",
    emptyDescription: "Add an xAI API key instead of `grok login`.",
    required: false,
    checkedWithBalance: false,
    placeholder: "xai-…",
  },
};

export function providerApiKeyField(driver: string): ProviderApiKeyField | undefined {
  return PROVIDER_API_KEY_FIELDS[driver];
}

/**
 * The entry a field owns, last one wins (the provider environment itself
 * resolves duplicates that way). The field claims its name whether or not the
 * entry is marked sensitive, so a plain-text one can still be replaced.
 */
export function providerApiKeyEntry(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  field: ProviderApiKeyField,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment.findLast((variable) => variable.name === field.name);
}

/** A key is saved once its entry exists and carries a value the server holds. */
export function hasSavedProviderApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  field: ProviderApiKeyField,
): boolean {
  const entry = providerApiKeyEntry(environment, field);
  if (entry === undefined) return false;
  return entry.valueRedacted === true || entry.value.trim().length > 0;
}

/** Save (or replace) the key. The entry is always sensitive, like the hand-typed one was. */
export function withProviderApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  field: ProviderApiKeyField,
  value: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return [
    ...environment.filter((variable) => variable.name !== field.name),
    { name: field.name, value, sensitive: true },
  ];
}

export function withoutProviderApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  field: ProviderApiKeyField,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return environment.filter((variable) => variable.name !== field.name);
}

export type ProviderApiKeyCheckTone = "pending" | "ok" | "rejected" | "quiet";

export interface ProviderApiKeyCheck {
  readonly tone: ProviderApiKeyCheckTone;
  readonly text: string;
}

/** Money in the currency DeepSeek reported; never converted, never rounded up. */
function formatBalance(amounts: { currency: string; totalBalance: number } | undefined): string {
  if (amounts === undefined) return "";
  const total = Math.round(amounts.totalBalance * 100) / 100;
  const fixed = total.toFixed(2);
  const symbol = amounts.currency.toUpperCase() === "USD" ? "$" : `${amounts.currency} `;
  return `${symbol}${fixed}`;
}

/**
 * What to say after a key was saved in this session, from the balance the
 * server read with it. The reading must be newer than the save, or it is the
 * previous key's answer; a same-second save and read is accepted, because the
 * probe timestamp is taken after the read that used the new key.
 *
 * A rejected key is named as such; a network problem is not, so a flaky
 * connection never reads as "your key is wrong".
 */
export function providerApiKeyCheckLine(input: {
  readonly field: ProviderApiKeyField;
  readonly balance: ServerProviderUsageBalance | undefined;
  /** When the key was saved in this session, or null when none was saved here. */
  readonly savedAtMs: number | null;
  readonly enabled: boolean;
}): ProviderApiKeyCheck | null {
  const { field } = input;
  if (!field.checkedWithBalance) return null;
  if (input.savedAtMs === null || !input.enabled) return null;
  const balance = input.balance;
  if (balance === undefined) return { tone: "pending", text: "Checking this key…" };
  const checkedAtMs = Date.parse(balance.checkedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs < input.savedAtMs) {
    return { tone: "pending", text: "Checking this key…" };
  }
  if (balance.status === "ready") {
    const money = formatBalance(balance.balance);
    return { tone: "ok", text: money.length > 0 ? `Key works · balance ${money}` : "Key works" };
  }
  if (balance.failureReason === "http_error") {
    return { tone: "rejected", text: `${field.displayName} didn't accept this key` };
  }
  return { tone: "quiet", text: "Could not check the key right now" };
}
