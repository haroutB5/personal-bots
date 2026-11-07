// @effect-diagnostics nodeBuiltinImport:off - Build-time scanner over the package tree.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ForbiddenRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

export interface Finding {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export const FORBIDDEN_RULES: ReadonlyArray<ForbiddenRule> = [
  {
    id: "upstream-package-id",
    pattern: /com\.t3tools/,
    why: "Upstream application ids. This app is com.haroutb5.hbots.",
  },
  {
    id: "upstream-deep-link",
    pattern: /t3code(?:-dev|-preview)?:\/\//,
    why: "Upstream URL scheme. This app answers to hbots://.",
  },
  {
    id: "expo-updates-url",
    pattern: /u\.expo\.dev|expo-updates|d763fcb8/,
    why: "Upstream OTA server. This app ships no OTA channel.",
  },
  {
    id: "axiom-tracing",
    pattern: /axiom/i,
    why: "Upstream trace exporter, key and import. Nothing is sent to a third party.",
  },
  {
    id: "upstream-relay-push",
    pattern:
      /remoteRegistration|getDevicePushTokenAsync|googleServicesFile|google-services|relay\.t3\.codes|T3CODE_RELAY_URL/,
    why: "Upstream relay push registration. Push comes later through the hbots server.",
  },
  {
    id: "eas-project",
    pattern: /\beas\b|projectId\s*:\s*["']|pingdotgg|ascAppId|expo\.dev/,
    why: "Upstream EAS project, owner and store ids. Builds run locally.",
  },
  {
    id: "upstream-host",
    pattern: /t3\.codes/,
    why: "Upstream hosts for legal pages and the relay.",
  },
  {
    id: "clerk-sign-in",
    pattern: /@clerk|CLERK/i,
    why: "The relay link is a one-time pairing token. No Clerk sign-in.",
  },
  {
    id: "tailscale",
    pattern: /tailscale|tailnet/i,
    why: "The phone reaches hbots through the relay. No Tailscale wording or action.",
  },
];

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "android",
  "ios",
  ".expo",
  ".tmp",
  "dist",
]);

const RULE_DEFINITION_FILES: ReadonlySet<string> = new Set([
  "scripts/forkHygiene.ts",
  "scripts/fork-hygiene.test.ts",
  "scripts/bundleScan.ts",
  "scripts/bundle-scan.test.ts",
]);

export function scanText(
  file: string,
  text: string,
  rules: ReadonlyArray<ForbiddenRule> = FORBIDDEN_RULES,
): ReadonlyArray<Finding> {
  const findings: Array<Finding> = [];
  text.split("\n").forEach((lineText, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(lineText)) {
        findings.push({ ruleId: rule.id, file, line: index + 1, text: lineText.trim() });
      }
    }
  });
  return findings;
}

function listFiles(root: string, directory: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const absolute = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...listFiles(root, absolute));
      }
    } else if (entry.isFile()) {
      files.push(NodePath.relative(root, absolute));
    }
  }
  return files;
}

export function scanPackage(root: string): ReadonlyArray<Finding> {
  return listFiles(root, root)
    .filter((file) => !RULE_DEFINITION_FILES.has(file))
    .flatMap((file) => {
      const content = NodeFS.readFileSync(NodePath.join(root, file));
      return content.includes(0) ? [] : scanText(file, content.toString("utf8"));
    });
}
