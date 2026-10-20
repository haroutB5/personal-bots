import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * What the provider page says about a built-in before the catalogue exists
 * (release 2 replaces this with the registry and the cost overlay). Wording
 * follows provider-setup SPEC sections 4 and 5; an unknown value is `null` and
 * the page says "Price not listed" or leaves the line out, never a guess.
 */
export interface ProviderFacts {
  readonly publisher: string;
  /** null when not known. */
  readonly openSource: boolean | null;
  readonly licence: string | null;
  readonly description: string;
  readonly cost: { readonly label: string; readonly detail: string | null } | null;
  readonly signIn: string | null;
  readonly from: string | null;
}

const FACTS: Readonly<Record<string, ProviderFacts>> = {
  claudeAgent: {
    publisher: "Anthropic",
    openSource: false,
    licence: null,
    description:
      "Anthropic's coding agent. Reads and edits code, runs commands and searches the web.",
    cost: {
      label: "Your Claude plan",
      detail: "It uses the Claude subscription you signed in with.",
    },
    signIn: "Claude account",
    from: "Installed on your laptop",
  },
  codex: {
    publisher: "OpenAI",
    openSource: true,
    licence: "Apache-2.0",
    description: "OpenAI's coding agent. Reads and edits code, runs commands and searches the web.",
    cost: {
      label: "Your ChatGPT plan",
      detail: "It uses the ChatGPT subscription you signed in with.",
    },
    signIn: "ChatGPT account",
    from: "Installed on your laptop",
  },
  opencode: {
    publisher: "OpenCode",
    openSource: true,
    licence: "MIT",
    description: "An open source coding agent that works with many model providers.",
    cost: {
      label: "Bring your own model key",
      detail: "Free models are listed; others need an account with their provider.",
    },
    signIn: "Server address",
    from: "Installed on your laptop",
  },
  cursor: {
    publisher: "Cursor",
    openSource: false,
    licence: null,
    description: "Cursor's agent. Reads and edits code and runs commands.",
    cost: { label: "Your Cursor plan", detail: "It uses the Cursor account you signed in with." },
    signIn: "Cursor account",
    from: "Installed on your laptop",
  },
  grok: {
    publisher: "xAI",
    openSource: false,
    licence: null,
    description: "xAI's coding agent. Reads and edits code and runs commands.",
    cost: { label: "Your xAI account or API key", detail: null },
    signIn: "xAI account or API key",
    from: "Installed on your laptop",
  },
  antigravity: {
    publisher: "Google",
    openSource: false,
    licence: null,
    description:
      "Google's coding agent for Gemini models. Reads and edits code, runs commands and searches the web.",
    cost: {
      label: "Free with a Google account",
      detail: "Daily limits apply. For more, sign in with a Google AI plan.",
    },
    signIn: "Google account",
    from: "Google download",
  },
  deepseek: {
    publisher: "DeepSeek",
    openSource: null,
    licence: null,
    description: "DeepSeek's models, run through hbots' own coding harness.",
    cost: {
      label: "API key, pay as you go",
      detail: "Billed by DeepSeek per message from your balance.",
    },
    signIn: "API key",
    from: "Installed on your laptop",
  },
};

export function providerFacts(driver: ProviderDriverKind | string | null): ProviderFacts | null {
  return driver === null ? null : (FACTS[driver] ?? null);
}

/** "Publisher · Open source" or "Publisher · Closed source" (just the publisher when unknown). */
export function publisherLine(facts: ProviderFacts | null): string | null {
  if (facts === null) return null;
  if (facts.openSource === null) return facts.publisher;
  return `${facts.publisher} · ${facts.openSource ? "Open source" : "Closed source"}`;
}

/** "Apache-2.0, open source" / "Closed source". */
export function licenceLine(facts: ProviderFacts | null): string | null {
  if (facts === null || facts.openSource === null) return null;
  if (!facts.openSource) return "Closed source";
  return facts.licence === null ? "Open source" : `${facts.licence}, open source`;
}

/** The install sheet's size: "About 130 MB", and a plain line while it is not known. */
export function downloadLine(totalBytes: number | null | undefined): string {
  if (totalBytes === null || totalBytes === undefined || totalBytes <= 0) {
    return "Size shown when the download starts";
  }
  return `About ${Math.max(1, Math.round(totalBytes / 1_000_000))} MB`;
}

export const BIG_DOWNLOAD_BYTES = 500_000_000;
