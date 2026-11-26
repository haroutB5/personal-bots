import {
  PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH,
  PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX,
  PERSONAL_EXTERNAL_MCP_SLUG_PATTERN,
  PERSONAL_EXTERNAL_MCP_URL_MAX_LENGTH,
  personalBotTeamLabel,
  type PersonalExternalMcpScope,
  type PersonalExternalMcpServer,
  type PersonalExternalMcpTestConnectionResult,
} from "@t3tools/contracts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const EXECUTOR_LOCAL_PRESET = {
  slug: "executor",
  displayName: "Executor",
  url: "http://127.0.0.1:4400/mcp",
} as const;

export interface ExternalMcpScopeOption {
  readonly value: PersonalExternalMcpScope;
  readonly label: string;
  readonly hint: string;
}

export const EXTERNAL_MCP_SCOPES: ReadonlyArray<ExternalMcpScopeOption> = [
  {
    value: "shared",
    label: "Shared",
    hint: "Every bot can use this server.",
  },
  {
    value: "team",
    label: "Team",
    hint: "Only bots in the chosen team can use this server.",
  },
  {
    value: "bot",
    label: "Bot",
    hint: "Only one bot can use this server.",
  },
];

export interface ExternalMcpDraft {
  readonly displayName: string;
  readonly slug: string;
  readonly url: string;
  readonly scope: PersonalExternalMcpScope;
  readonly scopeId: string | null;
}

export interface ExternalMcpDraftErrors {
  readonly displayName?: string;
  readonly slug?: string;
  readonly url?: string;
  readonly scopeId?: string;
}

export function emptyExternalMcpDraft(): ExternalMcpDraft {
  return {
    displayName: "",
    slug: "",
    url: "",
    scope: "shared",
    scopeId: null,
  };
}

export function draftFromExternalMcpServer(server: PersonalExternalMcpServer): ExternalMcpDraft {
  return {
    displayName: server.displayName,
    slug: server.slug,
    url: server.url,
    scope: server.scope,
    scopeId: server.scopeId,
  };
}

export function applyExecutorPreset(draft: ExternalMcpDraft): ExternalMcpDraft {
  return {
    ...draft,
    displayName: EXECUTOR_LOCAL_PRESET.displayName,
    slug: EXECUTOR_LOCAL_PRESET.slug,
    url: EXECUTOR_LOCAL_PRESET.url,
  };
}

export function slugFromDisplayName(displayName: string): string {
  const cleaned = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 32);
  return cleaned;
}

export function validateExternalMcpSlug(raw: string): string | null {
  const slug = raw.trim();
  if (slug.length === 0) {
    return "Enter a slug.";
  }
  if (!PERSONAL_EXTERNAL_MCP_SLUG_PATTERN.test(slug)) {
    return "Use 1 to 32 lowercase letters, numbers, hyphens or underscores, starting with a letter or number.";
  }
  if (slug === "t3-code" || slug.startsWith("t3-code")) {
    return 'Slugs starting with "t3-code" are reserved.';
  }
  return null;
}

export function validateExternalMcpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > PERSONAL_EXTERNAL_MCP_URL_MAX_LENGTH ||
    /\s/.test(trimmed)
  ) {
    return "Enter a valid URL.";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a valid URL.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "URL must not contain embedded credentials.";
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(host)) {
      return "Plain HTTP is only allowed for loopback hosts (127.0.0.1, localhost, [::1]).";
    }
  } else if (protocol !== "https:") {
    return "URL must use https:// or loopback http://.";
  }
  const pathname = parsed.pathname.toLowerCase();
  if (
    pathname === PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX ||
    pathname.startsWith(`${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/`)
  ) {
    return "URL cannot point to hbots's own external MCP proxy route.";
  }
  return null;
}

export function validateExternalMcpDraft(draft: ExternalMcpDraft): ExternalMcpDraftErrors {
  const errors: {
    displayName?: string;
    slug?: string;
    url?: string;
    scopeId?: string;
  } = {};

  const displayName = draft.displayName.trim();
  if (displayName.length === 0) {
    errors.displayName = "Enter a display name.";
  } else if (displayName.length > PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = `Display name must be ${PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }

  const slugError = validateExternalMcpSlug(draft.slug);
  if (slugError !== null) {
    errors.slug = slugError;
  }

  const urlError = validateExternalMcpUrl(draft.url);
  if (urlError !== null) {
    errors.url = urlError;
  }

  if (draft.scope === "team") {
    if ((draft.scopeId ?? "").trim().length === 0) {
      errors.scopeId = "Choose a team.";
    }
  } else if (draft.scope === "bot") {
    if ((draft.scopeId ?? "").trim().length === 0) {
      errors.scopeId = "Choose a bot.";
    }
  }

  return errors;
}

export function hasExternalMcpDraftErrors(errors: ExternalMcpDraftErrors): boolean {
  return (
    errors.displayName !== undefined ||
    errors.slug !== undefined ||
    errors.url !== undefined ||
    errors.scopeId !== undefined
  );
}

export function formatExternalMcpScopeBadge(
  scope: PersonalExternalMcpScope,
  scopeId: string | null,
  lookup?: {
    readonly botName?: (botId: string) => string | undefined;
    readonly teamLabel?: (team: string) => string;
  },
): string {
  if (scope === "shared") return "Shared";
  const trimmed = (scopeId ?? "").trim();
  if (scope === "team") {
    if (trimmed.length === 0) return "Team";
    const label = lookup?.teamLabel ? lookup.teamLabel(trimmed) : personalBotTeamLabel(trimmed);
    return `Team: ${label}`;
  }
  if (trimmed.length === 0) return "Bot";
  const name = lookup?.botName?.(trimmed);
  return `Bot: ${name ?? trimmed}`;
}

export function formatExternalMcpTokenStatus(hasToken: boolean): string {
  return hasToken ? "Token saved" : "No token";
}

export interface ExternalMcpTestSummary {
  readonly ok: boolean;
  readonly text: string;
}

export function formatExternalMcpTestResult(
  result: PersonalExternalMcpTestConnectionResult,
): ExternalMcpTestSummary {
  if (result.ok) {
    const name = result.serverName?.trim() ?? "";
    const version = result.serverVersion?.trim() ?? "";
    if (name.length > 0 && version.length > 0) {
      return { ok: true, text: `Connected to ${name} (${version})` };
    }
    if (name.length > 0) {
      return { ok: true, text: `Connected to ${name}` };
    }
    return { ok: true, text: "Connected" };
  }
  const error = result.error?.trim() ?? "";
  if (error.length > 0) {
    return { ok: false, text: error };
  }
  if (result.statusCode !== undefined) {
    return { ok: false, text: `Connection failed (HTTP ${result.statusCode})` };
  }
  return { ok: false, text: "Connection failed" };
}
