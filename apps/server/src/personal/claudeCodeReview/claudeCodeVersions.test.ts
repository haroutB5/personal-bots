import { assert, describe, it } from "@effect/vitest";

import {
  buildExcerpt,
  compareVersions,
  decideReview,
  EMPTY_REVIEW_STATE,
  maxVersion,
  normalizeVersion,
  parseChangelog,
  parseReviewState,
  reviewedThrough,
  sdkParityVersion,
  sectionsInRange,
  type ObservedVersions,
} from "./claudeCodeVersions.ts";

const CLI_CHANGELOG = `# Changelog

## 2.1.281

- Added \`"attribution": false\` in settings.json
- Fixed a crash while retrying

## 2.1.280

- Added MCP URL-mode elicitation

## 2.1.278

- Fixed resume

## 2.1.260

- Old entry
`;

const SDK_CHANGELOG = `# Changelog

## 0.3.281

- Changed the Settings type's attribution field
- Updated to parity with Claude Code v2.1.281

## 0.3.280

- Added verbatimPrompts option
- Updated to parity with Claude Code v2.1.280

## 0.3.260

- Updated to parity with Claude Code v2.1.260
`;

const observed = (overrides: Partial<ObservedVersions> = {}): ObservedVersions => ({
  latestClaudeCode: "2.1.281",
  installedClaudeCode: "2.1.281",
  latestSdk: "0.3.281",
  pinnedSdk: "0.3.260",
  pinnedSdkParityClaudeCode: "2.1.260",
  ...overrides,
});

describe("versions", () => {
  it("normalizes CLI output, package specs and junk", () => {
    assert.strictEqual(normalizeVersion("2.1.281 (Claude Code)"), "2.1.281");
    assert.strictEqual(normalizeVersion("^0.3.260"), "0.3.260");
    assert.strictEqual(normalizeVersion("v2.1.3"), "2.1.3");
    assert.strictEqual(normalizeVersion("latest"), null);
    assert.strictEqual(normalizeVersion(null), null);
  });

  it("compares numerically, not as strings", () => {
    assert.strictEqual(compareVersions("2.1.100", "2.1.99"), 1);
    assert.strictEqual(compareVersions("2.1.9", "2.1.10"), -1);
    assert.strictEqual(compareVersions("2.1", "2.1.0"), 0);
    assert.strictEqual(maxVersion(null, "2.1.9", "2.1.10", null), "2.1.10");
    assert.strictEqual(maxVersion(null, null), null);
  });
});

describe("changelog", () => {
  it("splits sections and slices the exclusive-inclusive range", () => {
    const sections = parseChangelog(CLI_CHANGELOG);
    assert.deepStrictEqual(
      sections.map((section) => section.version),
      ["2.1.281", "2.1.280", "2.1.278", "2.1.260"],
    );
    assert.deepStrictEqual(
      sectionsInRange(sections, "2.1.260", "2.1.280").map((section) => section.version),
      ["2.1.280", "2.1.278"],
    );
    assert.strictEqual(sections[0]!.body.includes("attribution"), true);
  });

  it("reads the Claude Code version an SDK release matches", () => {
    const sdk = parseChangelog(SDK_CHANGELOG);
    assert.strictEqual(sdkParityVersion(sdk, "0.3.260"), "2.1.260");
    assert.strictEqual(sdkParityVersion(sdk, "0.3.999"), null);
  });
});

describe("decideReview (once per version)", () => {
  it("first review starts at the pinned SDK and covers everything up to latest", () => {
    const decision = decideReview(EMPTY_REVIEW_STATE, observed());
    assert.deepStrictEqual(decision, {
      _tag: "Review",
      claudeCode: { from: "2.1.260", to: "2.1.281" },
      sdk: { from: "0.3.260", to: "0.3.281" },
    });
  });

  it("is up to date once the latest versions were reviewed", () => {
    const state = { ...EMPTY_REVIEW_STATE, reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.281" };
    assert.deepStrictEqual(decideReview(state, observed()), { _tag: "UpToDate" });
  });

  it("reviews only the versions after the last review", () => {
    const state = { ...EMPTY_REVIEW_STATE, reviewedClaudeCode: "2.1.280", reviewedSdk: "0.3.280" };
    assert.deepStrictEqual(decideReview(state, observed()), {
      _tag: "Review",
      claudeCode: { from: "2.1.280", to: "2.1.281" },
      sdk: { from: "0.3.280", to: "0.3.281" },
    });
  });

  it("uses the installed binary when it is ahead of npm (or npm is unreachable)", () => {
    const state = { ...EMPTY_REVIEW_STATE, reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.281" };
    const decision = decideReview(
      state,
      observed({ latestClaudeCode: null, installedClaudeCode: "2.1.282" }),
    );
    assert.deepStrictEqual(decision, {
      _tag: "Review",
      claudeCode: { from: "2.1.281", to: "2.1.282" },
      sdk: null,
    });
  });

  it("reviews an SDK-only release", () => {
    const state = { ...EMPTY_REVIEW_STATE, reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.280" };
    assert.deepStrictEqual(decideReview(state, observed()), {
      _tag: "Review",
      claudeCode: null,
      sdk: { from: "0.3.280", to: "0.3.281" },
    });
  });

  it("records a baseline when the pinned SDK cannot be placed", () => {
    const decision = decideReview(
      EMPTY_REVIEW_STATE,
      observed({ pinnedSdkParityClaudeCode: null }),
    );
    assert.deepStrictEqual(decision, { _tag: "Baseline", claudeCode: "2.1.281", sdk: "0.3.281" });
  });

  it("never reviews backwards when npm reports an older version", () => {
    const state = { ...EMPTY_REVIEW_STATE, reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.281" };
    const decision = decideReview(
      state,
      observed({ latestClaudeCode: "2.1.270", installedClaudeCode: null, latestSdk: "0.3.270" }),
    );
    assert.deepStrictEqual(decision, { _tag: "UpToDate" });
  });

  it("advances reviewed only through versions that had notes", () => {
    // npm has 2.1.282, the changelog only reaches 2.1.281: 2.1.282 stays unreviewed.
    assert.strictEqual(
      reviewedThrough("2.1.280", { from: "2.1.280", to: "2.1.282" }, ["2.1.281"]),
      "2.1.281",
    );
    assert.strictEqual(reviewedThrough(null, { from: "2.1.260", to: "2.1.281" }, []), "2.1.260");
    assert.strictEqual(reviewedThrough("0.3.281", null, []), "0.3.281");
  });

  it("reads a damaged state as empty", () => {
    assert.deepStrictEqual(parseReviewState("not json"), EMPTY_REVIEW_STATE);
    assert.deepStrictEqual(parseReviewState(null), EMPTY_REVIEW_STATE);
    assert.strictEqual(
      parseReviewState(JSON.stringify({ reviewedClaudeCode: "2.1.281" })).reviewedClaudeCode,
      "2.1.281",
    );
  });
});

describe("buildExcerpt", () => {
  it("includes the range in full, newest first, with both changelogs", () => {
    const excerpt = buildExcerpt({
      claudeCode: { from: "2.1.260", to: "2.1.281" },
      sdk: { from: "0.3.260", to: "0.3.281" },
      claudeCodeSections: parseChangelog(CLI_CHANGELOG),
      sdkSections: parseChangelog(SDK_CHANGELOG),
      observed: observed(),
      generatedAt: "2026-09-24T10:00:00.000Z",
    });
    assert.deepStrictEqual(excerpt.claudeCodeVersions, ["2.1.281", "2.1.280", "2.1.278"]);
    assert.deepStrictEqual(excerpt.sdkVersions, ["0.3.281", "0.3.280"]);
    assert.deepStrictEqual(excerpt.condensedVersions, []);
    assert.strictEqual(excerpt.markdown.includes("Old entry"), false);
    assert.strictEqual(excerpt.markdown.includes("verbatimPrompts"), true);
    assert.ok(excerpt.markdown.indexOf("### 2.1.281") < excerpt.markdown.indexOf("### 2.1.278"));
  });

  it("condenses the oldest releases when the range is over budget", () => {
    const excerpt = buildExcerpt({
      claudeCode: { from: "2.1.260", to: "2.1.281" },
      sdk: null,
      claudeCodeSections: parseChangelog(CLI_CHANGELOG),
      sdkSections: [],
      observed: observed(),
      generatedAt: "2026-09-24T10:00:00.000Z",
      fullTextBudget: 120,
    });
    assert.deepStrictEqual(excerpt.condensedVersions, ["2.1.280", "2.1.278"]);
    assert.strictEqual(excerpt.markdown.includes("### 2.1.280 (condensed)"), true);
    assert.strictEqual(excerpt.markdown.includes("(no Agent SDK changes)"), true);
  });
});
