// The verification stamp. Each commit says how it was verified in a `Verified:` trailer,
// or `Verified: none (<reason>)`. Pure: the callers read git and pass plain data in.
// The mode is read from the change's base, like the test budget's `enforce`, so a
// change cannot switch the gate off for itself. Observe reports and never blocks;
// enforce blocks the release plan when a commit that needs a stamp has none.

export const STAMP_MODE_FILE = "scripts/personal/qa/verify-stamp.json";
export const MODES = ["off", "observe", "enforce"];
export const DEFAULT_MODE = "observe";
export const MAX_LISTED = 20;

/** The mode a file at the base names. A missing file is the default; an unusable one is the default with a warning. */
export function readMode(source) {
  if (source == null) return { mode: DEFAULT_MODE };
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { mode: DEFAULT_MODE, warning: `${STAMP_MODE_FILE} is not valid JSON: ${error.message}` };
  }
  if (!MODES.includes(data?.mode))
    return { mode: DEFAULT_MODE, warning: `${STAMP_MODE_FILE} mode must be one of ${MODES.join(", ")}` };
  return { mode: data.mode };
}

const NONE = /^none\s*\(\s*(\S[^]*?)\s*\)$/;

/** One commit's stamp from the values of its `Verified` trailers: the first usable one wins. */
export function readStamp(values) {
  const stamps = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const none = NONE.exec(value);
      if (none) return { kind: "none", reason: none[1] };
      if (/^none\b/i.test(value)) return { kind: "missing" };
      return { kind: "verified", how: value };
    });
  return stamps.find((stamp) => stamp.kind !== "missing") ?? { kind: "missing" };
}

/** The subject prefix of the release version and notes commits. */
export const RELEASE_SUBJECT = /^(?:chore|docs)\(release\):/;
const RELEASE_PATHS = [
  /^apps\/hbots-mobile\/package\.json$/,
  /^scripts\/personal\/app-version\.txt$/,
  /^scripts\/personal\/linux\/hbots-release\/PINS\.json$/,
  /^docs\/releases\/[^/]+\.md$/,
];

/** A release version or notes commit: the release subject and nothing but release files, so a subject alone exempts no code. */
export const isReleaseCommit = ({ subject, paths }) =>
  RELEASE_SUBJECT.test(subject) &&
  paths.length > 0 &&
  paths.every((path) => RELEASE_PATHS.some((pattern) => pattern.test(path)));

/**
 * A range of commits against the mode. A commit is `{ sha, parents, subject, paths, trailers }`.
 * Merge commits (more than one parent) and release commits need no stamp. `total` counts
 * the commits that do.
 */
export function judgeStamps({ mode, commits }) {
  const exempt = commits.filter((commit) => commit.parents > 1 || isReleaseCommit(commit));
  const exemptShas = new Set(exempt.map((commit) => commit.sha));
  const judged = commits
    .filter((commit) => !exemptShas.has(commit.sha))
    .map((commit) => ({ commit, stamp: readStamp(commit.trailers) }));
  const unstamped = judged.filter(({ stamp }) => stamp.kind === "missing").map(({ commit }) => commit);
  return {
    mode: mode.mode,
    ...(mode.warning ? { warning: mode.warning } : {}),
    total: judged.length,
    unstamped,
    stampedNone: judged.filter(({ stamp }) => stamp.kind === "none").length,
    exempt: exempt.length,
    blocks: mode.mode === "enforce" && unstamped.length > 0,
  };
}

/** The lines to print. Off says nothing; only a blocking result starts with FAIL. */
export function stampLines(result) {
  const warning = result.warning ? [`WARNING: ${result.warning}; observe mode`] : [];
  if (result.mode === "off") return [];
  const count = `${result.unstamped.length} of ${result.total} commits unstamped`;
  const detail = `${result.stampedNone} stamped none, ${result.exempt} exempt`;
  const listed = result.unstamped
    .slice(0, MAX_LISTED)
    .map((commit) => `  ${commit.sha.slice(0, 10)} ${commit.subject}`);
  const more = result.unstamped.length - listed.length;
  const tail = more > 0 ? [`  ... and ${more} more`] : [];
  if (result.mode === "observe")
    return [...warning, `verify stamp: ${count} (observe, never blocks; ${detail})`, ...listed, ...tail];
  return [
    `${result.blocks ? "FAIL " : ""}verify stamp: ${count} (enforce; ${detail})`,
    ...listed,
    ...tail,
    ...(result.blocks
      ? [`  to pass: add "Verified: <how>" or "Verified: none (<reason>)" as the last paragraph of each commit message`]
      : []),
  ];
}
