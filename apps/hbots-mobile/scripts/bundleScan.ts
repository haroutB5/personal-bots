export interface BundleRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

export interface AllowedStrings {
  readonly id: string;
  readonly ruleId: string;
  readonly strings: ReadonlyArray<string>;
  readonly why: string;
}

export interface BundleFinding {
  readonly ruleId: string;
  readonly match: string;
  readonly context: string;
}

export const BUNDLE_RULES: ReadonlyArray<BundleRule> = [
  { id: "upstream-package-id", pattern: /com\.t3tools/, why: "Upstream application id." },
  { id: "upstream-deep-link", pattern: /t3code(?:-dev|-preview)?:\/\//, why: "Upstream scheme." },
  { id: "expo-updates-url", pattern: /u\.expo\.dev|d763fcb8/, why: "Upstream OTA server." },
  { id: "axiom-tracing", pattern: /axiom/i, why: "Upstream trace exporter." },
  { id: "eas-owner", pattern: /pingdotgg|ascAppId/, why: "Upstream EAS owner and store id." },
  { id: "upstream-host", pattern: /t3\.codes/, why: "Upstream legal and relay host." },
  {
    id: "upstream-relay-push",
    pattern: /relay\.t3\.codes|T3CODE_RELAY_URL|getDevicePushTokenAsync|googleServicesFile/,
    why: "Upstream relay push registration.",
  },
  { id: "clerk-sign-in", pattern: /@clerk\//, why: "No Clerk sign-in package." },
];

/**
 * Lead decision, 1 Nov 2026: these come in through packages/shared and
 * packages/contracts and are never called by the app.
 */
export const ALLOWED_STRINGS: ReadonlyArray<AllowedStrings> = [
  {
    id: "axiom-dataset-header",
    ruleId: "axiom-tracing",
    strings: ["X-Axiom-Dataset"],
    why: "Header name in the shared trace exporter. No Axiom URL or token is bundled.",
  },
  {
    id: "t3-project-file-schema",
    ruleId: "upstream-host",
    strings: ["https://t3.codes/schema/t3.json", "See https://t3.codes for documentation"],
    why: "Schema URL and description of the T3 project file contract.",
  },
  {
    id: "pairing-app-link",
    ruleId: "upstream-deep-link",
    strings: ["t3code://pair?"],
    why: "Link builder in shared/remote, bundled through the client-runtime connection barrel. The phone scans QR URLs and never opens the scheme.",
  },
  {
    id: "connect-troubleshooting-link",
    ruleId: "eas-owner",
    strings: [
      "https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md",
    ],
    why: "Docs URL in the contracts connection error helper. The phone opens no upstream repository.",
  },
  {
    id: "hosted-app-url",
    ruleId: "upstream-host",
    strings: ["https://app.t3.codes"],
    why: "Default hosted app URL in shared/connectAuth, bundled through the client-runtime connection barrel. The phone never opens it.",
  },
];

const CONTEXT_CHARS = 60;

export function scanBundle(text: string): ReadonlyArray<BundleFinding> {
  const findings: Array<BundleFinding> = [];
  for (const rule of BUNDLE_RULES) {
    const allowed = ALLOWED_STRINGS.filter((entry) => entry.ruleId === rule.id).flatMap(
      (entry) => entry.strings,
    );
    const stripped = allowed.reduce((rest, value) => rest.split(value).join("\u0000"), text);
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`);
    for (const hit of stripped.matchAll(global)) {
      const start = hit.index ?? 0;
      findings.push({
        ruleId: rule.id,
        match: hit[0],
        context: stripped
          .slice(Math.max(0, start - CONTEXT_CHARS), start + hit[0].length + CONTEXT_CHARS)
          .replaceAll("\u0000", "…")
          .replace(/\s+/gu, " "),
      });
    }
  }
  return findings;
}
