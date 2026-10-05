/**
 * Ad and tracker blocking for the shared Chrome, done by Chrome itself.
 *
 * The launch passes one `--host-rules` switch that maps the hosts of well-known ad and
 * tracker networks (`adblockDomains.ts`) to "not found". The mapping lives in Chrome's
 * network stack, so it covers every frame, worker and popup, adds no per-request round trip
 * to this process, leaves Chrome's HTTP cache alone, and costs nothing when a page makes no
 * request to a listed host. The alternatives were tried and lost. A CDP URL block list
 * (`Network.setBlockedURLs`) is matched linearly: a page of 800 images loaded in 0.38 s with
 * none and 3 s with 6,000 patterns. A request route (Playwright `route`, Ghostery's
 * `@ghostery/adblocker-playwright` with EasyList and EasyPrivacy) blocked no more than this on
 * the two pages compared (Vinted, a recipe page), but adds a dependency, an in-memory filter
 * engine, and a round trip through this process for every request. An unpacked extension is not
 * loaded by branded Chrome 154.
 *
 * Only hosts on the list are touched, and the list holds ad, analytics and tracking networks,
 * never a site's own hosts, a CDN, a payment, bot-protection or CAPTCHA provider.
 * `adblock.test.ts` pins that. A request to a listed host fails with
 * `net::ERR_NAME_NOT_RESOLVED`; the counter below tells those apart from real DNS failures by
 * checking the host against the list, and never keeps a URL.
 *
 * Kill switch: `T3CODE_PERSONAL_BROWSER_ADBLOCK=off` (also 0, false, no) launches Chrome with
 * exactly the arguments it had before this existed.
 *
 * @module personal/browser/adblock
 */
import { ADBLOCK_HOST_PATTERNS } from "./adblockDomains.ts";

export const ADBLOCK_ENV_NAME = "T3CODE_PERSONAL_BROWSER_ADBLOCK";

/** Windows caps a command line at 32,767 characters; Playwright's own switches and the profile path need the rest. */
export const ADBLOCK_MAX_ARG_CHARS = 24_000;

export const adblockEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !/^(off|0|false|no)$/i.test((env[ADBLOCK_ENV_NAME] ?? "").trim());

/** The Chrome switch that blocks `patterns` (host globs such as `*.doubleclick.net`). */
export const adblockHostRulesArg = (patterns: ReadonlyArray<string>): string =>
  `--host-rules=${patterns.map((pattern) => `MAP ${pattern} ^NOTFOUND`).join(",")}`;

/** Extra Chrome launch arguments: none when the kill switch is off or the list is empty. */
export const adblockLaunchArgs = (
  env: NodeJS.ProcessEnv = process.env,
  patterns: ReadonlyArray<string> = ADBLOCK_HOST_PATTERNS,
): ReadonlyArray<string> =>
  adblockEnabled(env) && patterns.length > 0 ? [adblockHostRulesArg(patterns)] : [];

export interface AdblockStats {
  /** False when the kill switch is off (then `rules` and `blocked` are 0). */
  readonly enabled: boolean;
  /** Host rules Chrome was launched with. */
  readonly rules: number;
  /** Requests the browser's pages made. */
  readonly requests: number;
  /** Of those, the ones that failed because their host is on the list. */
  readonly blocked: number;
}

const NAME_NOT_RESOLVED = "net::ERR_NAME_NOT_RESOLVED";

/** Whether a host falls under one of the patterns (`*.x` covers every host under x, a bare `x` only x). */
export function makeHostMatcher(patterns: ReadonlyArray<string>): (host: string) => boolean {
  const suffixes = new Set<string>();
  const exact = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) suffixes.add(pattern.slice(2));
    else exact.add(pattern);
  }
  return (host) => {
    if (exact.has(host)) return true;
    let at = host.indexOf(".");
    while (at !== -1) {
      if (suffixes.has(host.slice(at + 1))) return true;
      at = host.indexOf(".", at + 1);
    }
    return false;
  };
}

/**
 * Counts requests and the ones the host rules blocked, for the one summary line per launch.
 * It only watches: with the kill switch off the browser itself is untouched.
 */
export function makeAdblockCounter(
  patterns: ReadonlyArray<string> = ADBLOCK_HOST_PATTERNS,
  enabled = true,
) {
  const listed = makeHostMatcher(patterns);
  let requests = 0;
  let blocked = 0;
  return {
    request: () => {
      requests += 1;
    },
    failed: (url: string, errorText: string) => {
      if (!enabled || errorText !== NAME_NOT_RESOLVED) return;
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return;
      }
      if (listed(host)) blocked += 1;
    },
    snapshot: (): AdblockStats => ({
      enabled,
      rules: enabled ? patterns.length : 0,
      requests,
      blocked,
    }),
  };
}

export type AdblockCounter = ReturnType<typeof makeAdblockCounter>;
