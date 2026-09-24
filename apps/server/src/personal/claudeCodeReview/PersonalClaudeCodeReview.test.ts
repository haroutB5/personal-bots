// @effect-diagnostics preferSchemaOverJson:off - the payload the service sends is free-form JSON the bot reads as data; these assert on it verbatim.
import {
  PersonalBotId,
  PersonalRoutineId,
  PersonalTaskId,
  type PersonalRoutine,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import { CLAUDE_CODE_REVIEW_STATE_KEY, parseReviewState } from "./claudeCodeVersions.ts";
import {
  AGENT_SDK_CHANGELOG,
  CHECK_MIN_INTERVAL_MS,
  CLAUDE_CODE_CHANGELOG,
  CLAUDE_CODE_REVIEW_SETUP_KEY,
  claudeCodeReviewEnabled,
  makeWith,
  NPM_AGENT_SDK_LATEST,
  NPM_CLAUDE_CODE_LATEST,
  npmLatestVersion,
  type PersonalClaudeCodeReviewDeps,
} from "./PersonalClaudeCodeReview.ts";

const cliChangelog = (versions: ReadonlyArray<string>) =>
  ["# Changelog", ...versions.map((version) => `## ${version}\n\n- Change in ${version}`)].join(
    "\n\n",
  );
const sdkChangelog = (versions: ReadonlyArray<string>) =>
  [
    "# Changelog",
    ...versions.map(
      (version) =>
        `## ${version}\n\n- SDK change in ${version}\n- Updated to parity with Claude Code v2.1.${version.split(".")[2]}`,
    ),
  ].join("\n\n");

const routine = (overrides: Partial<PersonalRoutine> = {}): PersonalRoutine =>
  ({
    routineId: PersonalRoutineId.make("routine-claude-code-update-review"),
    botId: PersonalBotId.make("personal-claude-code-updates"),
    title: "Claude Code update review",
    prompt: "review",
    trigger: "event",
    schedule: null,
    eventLabel: "New Claude Code version",
    hookToken: "token",
    lastFiredAt: null,
    timeZone: "Europe/London",
    enabled: true,
    missedPolicy: "coalesce",
    delivery: "model",
    nextDueAt: null,
    lastOccurrenceLocal: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as PersonalRoutine;

const makeHarness = () => {
  const state = {
    meta: new Map<string, string>(),
    npmCli: "2.1.281" as string | null,
    npmSdk: "0.3.281" as string | null,
    installed: "2.1.281" as string | null,
    cliVersions: ["2.1.281", "2.1.280", "2.1.260"],
    sdkVersions: ["0.3.281", "0.3.280", "0.3.260"],
    routine: routine() as PersonalRoutine | null,
    fireResult: "Fired" as "Fired" | "Failed" | "NotFound",
    fired: [] as Array<PersonalRoutineService.PersonalRoutineFireEventInput>,
    files: new Map<string, string>(),
    botsCreated: 0,
    routinesCreated: 0,
    fetched: [] as Array<string>,
  };
  const deps: PersonalClaudeCodeReviewDeps = {
    enabled: true,
    paths: { repoDir: "C:/repo", notesDir: "C:/notes" },
    excerptDir: "C:/state/claude-code-updates",
    pinnedSdk: "0.3.260",
    fetchText: (url) =>
      Effect.suspend(() => {
        state.fetched.push(url);
        const reply = (value: string | null) =>
          value === null
            ? Effect.fail({ message: "offline" })
            : Effect.succeed(JSON.stringify({ version: value }));
        if (url === NPM_CLAUDE_CODE_LATEST) return reply(state.npmCli);
        if (url === NPM_AGENT_SDK_LATEST) return reply(state.npmSdk);
        if (url === CLAUDE_CODE_CHANGELOG) return Effect.succeed(cliChangelog(state.cliVersions));
        if (url === AGENT_SDK_CHANGELOG) return Effect.succeed(sdkChangelog(state.sdkVersions));
        return Effect.fail({ message: `unexpected ${url}` });
      }),
    installedClaudeCode: Effect.sync(() => state.installed),
    getMeta: (key) => Effect.sync(() => Option.fromNullishOr(state.meta.get(key))),
    setMeta: (key, value) => Effect.sync(() => void state.meta.set(key, value)),
    createBot: () => Effect.sync(() => void state.botsCreated++),
    createRoutine: () => Effect.sync(() => void state.routinesCreated++),
    getRoutine: () => Effect.sync(() => Option.fromNullishOr(state.routine)),
    fireEvent: (input) =>
      Effect.sync(() => {
        state.fired.push(input);
        return state.fireResult === "Fired"
          ? { _tag: "Fired" as const, taskId: PersonalTaskId.make(`task-${state.fired.length}`) }
          : { _tag: state.fireResult };
      }),
    writeFile: (path, text) => Effect.sync(() => void state.files.set(path, text)),
  };
  const reviewState = () => parseReviewState(state.meta.get(CLAUDE_CODE_REVIEW_STATE_KEY) ?? null);
  return { state, deps, reviewState };
};

it("reads the version from an npm latest document", () => {
  assert.strictEqual(npmLatestVersion('{"version":"2.1.281"}'), "2.1.281");
  assert.strictEqual(npmLatestVersion("<html>"), null);
});

it("runs only on the live Bots server unless forced by env", () => {
  assert.strictEqual(claudeCodeReviewEnabled({ T3CODE_ENVIRONMENT_LABEL: "Bots" }), true);
  assert.strictEqual(claudeCodeReviewEnabled({}), false);
  assert.strictEqual(claudeCodeReviewEnabled({ PB_CLAUDE_CODE_REVIEW: "1" }), true);
  assert.strictEqual(
    claudeCodeReviewEnabled({ T3CODE_ENVIRONMENT_LABEL: "Bots", PB_CLAUDE_CODE_REVIEW: "0" }),
    false,
  );
});

it.effect("first check sets up the bot once and reviews since the pinned SDK", () =>
  Effect.gen(function* () {
    const { state, deps, reviewState } = makeHarness();
    const service = yield* makeWith(deps);
    const result = yield* service.check();
    assert.strictEqual(result._tag, "Fired");
    assert.strictEqual(state.botsCreated, 1);
    assert.strictEqual(state.routinesCreated, 1);
    assert.strictEqual(state.meta.get(CLAUDE_CODE_REVIEW_SETUP_KEY), "1");

    const payload = JSON.parse(state.fired[0]!.body) as Record<string, any>;
    assert.deepStrictEqual(payload.claudeCode.after, "2.1.260");
    assert.deepStrictEqual(payload.claudeCode.upTo, "2.1.281");
    assert.deepStrictEqual(payload.agentSdk.after, "0.3.260");
    assert.strictEqual(payload.reportFile, "C:/notes/claude-code-updates/2.1.281.md");
    assert.strictEqual(state.files.size, 1);
    assert.strictEqual(String(payload.changelogExcerpt).endsWith("changelog-2.1.281.md"), true);
    const excerpt = [...state.files.values()][0]!;
    assert.strictEqual(excerpt.includes("Change in 2.1.281"), true);
    assert.strictEqual(excerpt.includes("Change in 2.1.260"), false);

    assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.281");
    assert.strictEqual(reviewState().reviewedSdk, "0.3.281");
    assert.strictEqual(reviewState().lastReview?.taskId, "task-1");
  }),
);

it.effect("reviews each version once: no second review until a newer release", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    yield* service.check();
    // Same day: throttled without touching the network.
    const fetchesBefore = state.fetched.length;
    assert.strictEqual((yield* service.check())._tag, "Throttled");
    assert.strictEqual(state.fetched.length, fetchesBefore);
    // Next day, nothing new.
    yield* TestClock.adjust(CHECK_MIN_INTERVAL_MS);
    assert.strictEqual((yield* service.check())._tag, "UpToDate");
    assert.strictEqual(state.fired.length, 1);
    // A new release the day after: reviewed, only its own range.
    yield* TestClock.adjust(CHECK_MIN_INTERVAL_MS);
    state.npmCli = "2.1.282";
    state.npmSdk = "0.3.282";
    state.cliVersions = ["2.1.282", ...state.cliVersions];
    state.sdkVersions = ["0.3.282", ...state.sdkVersions];
    assert.strictEqual((yield* service.check())._tag, "Fired");
    const payload = JSON.parse(state.fired[1]!.body) as Record<string, any>;
    assert.strictEqual(payload.claudeCode.after, "2.1.281");
    assert.strictEqual(payload.claudeCode.upTo, "2.1.282");
    assert.strictEqual(payload.claudeCode.releasesWithNotes, 1);
    // The bot and routine are never created again.
    assert.strictEqual(state.botsCreated, 1);
    assert.strictEqual(state.routinesCreated, 1);
  }),
);

it.effect("a paused routine records nothing, so resuming reviews the whole range", () =>
  Effect.gen(function* () {
    const { state, deps, reviewState } = makeHarness();
    state.routine = routine({ enabled: false });
    const service = yield* makeWith(deps);
    assert.strictEqual((yield* service.check())._tag, "RoutineUnavailable");
    assert.strictEqual(state.fired.length, 0);
    assert.strictEqual(reviewState().reviewedClaudeCode, null);
    state.routine = routine();
    yield* TestClock.adjust(CHECK_MIN_INTERVAL_MS);
    assert.strictEqual((yield* service.check())._tag, "Fired");
    const payload = JSON.parse(state.fired[0]!.body) as Record<string, any>;
    assert.strictEqual(payload.claudeCode.after, "2.1.260");
  }),
);

it.effect("a deleted routine is not recreated and no review fires", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.meta.set(CLAUDE_CODE_REVIEW_SETUP_KEY, "1");
    state.routine = null;
    const service = yield* makeWith(deps);
    assert.strictEqual((yield* service.check())._tag, "RoutineUnavailable");
    assert.strictEqual(state.routinesCreated, 0);
    assert.strictEqual(state.botsCreated, 0);
  }),
);

it.effect("a failed start is retried on the next check, not marked reviewed", () =>
  Effect.gen(function* () {
    const { state, deps, reviewState } = makeHarness();
    state.fireResult = "Failed";
    const service = yield* makeWith(deps);
    assert.strictEqual((yield* service.check())._tag, "FireFailed");
    assert.strictEqual(reviewState().reviewedClaudeCode, null);
    state.fireResult = "Fired";
    yield* TestClock.adjust(CHECK_MIN_INTERVAL_MS);
    assert.strictEqual((yield* service.check())._tag, "Fired");
  }),
);

it.effect("offline: not stamped, so the next hourly wake-up tries again", () =>
  Effect.gen(function* () {
    const { state, deps, reviewState } = makeHarness();
    state.npmCli = null;
    state.npmSdk = null;
    state.installed = null;
    const service = yield* makeWith(deps);
    assert.strictEqual((yield* service.check())._tag, "Unreachable");
    assert.strictEqual(reviewState().lastCheckedAt, null);
  }),
);

it.effect("a release on npm before its notes waits for them instead of being skipped", () =>
  Effect.gen(function* () {
    const { state, deps, reviewState } = makeHarness();
    state.meta.set(
      CLAUDE_CODE_REVIEW_STATE_KEY,
      JSON.stringify({ reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.281" }),
    );
    state.npmCli = "2.1.282";
    const service = yield* makeWith(deps);
    assert.strictEqual((yield* service.check())._tag, "ChangelogPending");
    assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.281");
    state.cliVersions = ["2.1.282", ...state.cliVersions];
    yield* TestClock.adjust(CHECK_MIN_INTERVAL_MS);
    assert.strictEqual((yield* service.check())._tag, "Fired");
    assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.282");
  }),
);

it.effect("does nothing when disabled", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith({ ...deps, enabled: false });
    assert.strictEqual((yield* service.check())._tag, "Disabled");
    assert.strictEqual(state.botsCreated, 0);
    assert.strictEqual(state.fetched.length, 0);
  }),
);
