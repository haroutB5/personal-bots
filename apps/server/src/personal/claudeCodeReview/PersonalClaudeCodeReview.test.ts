// @effect-diagnostics preferSchemaOverJson:off - the run data the service writes is free-form JSON the bot reads; these assert on it verbatim.
import {
  PersonalBotId,
  PersonalTaskId,
  type PersonalRoutine,
  type PersonalRoutineCreateInput,
  type PersonalTask,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import { CLAUDE_CODE_REVIEW_STATE_KEY, parseReviewState } from "./claudeCodeVersions.ts";
import {
  AGENT_SDK_CHANGELOG,
  CLAUDE_CODE_CHANGELOG,
  CLAUDE_CODE_REVIEW_SETUP_KEY,
  claudeCodeReviewEnabled,
  installedVersionWithFallback,
  makeWith,
  nightlyRunId,
  NPM_AGENT_SDK_LATEST,
  NPM_CLAUDE_CODE_LATEST,
  npmLatestVersion,
  type PersonalClaudeCodeReviewDeps,
} from "./PersonalClaudeCodeReview.ts";
import { addProposal, decideProposal, EMPTY_LEDGER, serializeLedger } from "./proposalLedger.ts";
import {
  LEGACY_UPDATES_ROUTINE_ID,
  legacyUpdatesBotInstructions,
  UPDATES_NIGHTLY_ROUTINE_ID,
  UPDATES_REPORT_ROUTINE_ID,
  updatesBotInstructions,
} from "./reviewPrompts.ts";

const PATHS = { repoDir: "C:/repo", notesDir: "C:/notes" };
const LEDGER = "C:/notes/claude-code-updates/proposals.json";
const HOME = "C:/home/claude-code-updates";

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

const routineRow = (input: PersonalRoutineCreateInput): PersonalRoutine =>
  ({
    routineId: input.routineId,
    botId: input.botId,
    title: input.title,
    prompt: input.prompt,
    trigger: input.trigger ?? "schedule",
    schedule: input.schedule ?? null,
    eventLabel: input.eventLabel ?? null,
    hookToken: input.trigger === "event" ? "report-token-1" : null,
    lastFiredAt: null,
    timeZone: input.timeZone ?? "Europe/London",
    enabled: true,
    missedPolicy: input.missedPolicy ?? "coalesce",
    delivery: input.delivery ?? "model",
    nextDueAt: null,
    lastOccurrenceLocal: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  }) as PersonalRoutine;

/** P1..P5 from the 2.1.281 review, all open. */
const seededLedger = () => {
  let ledger = EMPTY_LEDGER;
  for (const title of [
    "Bump SDK",
    "System prompt snapshot",
    "Installed version",
    "Plan panel",
    "canUseTool hints",
  ]) {
    ledger = addProposal(ledger, { title, source: "2.1.281" }, "2026-09-24T19:00:00Z", null).ledger;
  }
  return ledger;
};

const makeHarness = () => {
  const state = {
    meta: new Map<string, string>(),
    npmCli: "2.1.281" as string | null,
    npmSdk: "0.3.281" as string | null,
    installed: "2.1.281" as string | null,
    cliVersions: ["2.1.281", "2.1.280", "2.1.260"],
    sdkVersions: ["0.3.281", "0.3.280", "0.3.260"],
    bot: null as { instructions: string } | null,
    botUpdates: [] as Array<string>,
    botsCreated: 0,
    routines: new Map<string, PersonalRoutine>(),
    removed: [] as Array<string>,
    preparers: new Map<string, PersonalRoutineService.PersonalRoutinePreparer>(),
    files: new Map<string, string>(),
    fetched: [] as Array<string>,
  };
  const deps: PersonalClaudeCodeReviewDeps = {
    enabled: true,
    paths: PATHS,
    excerptDir: "C:/state/claude-code-updates",
    updatesHome: HOME,
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
    getBot: () => Effect.sync(() => Option.fromNullishOr(state.bot)),
    createBot: () =>
      Effect.sync(() => {
        state.botsCreated++;
        state.bot = { instructions: updatesBotInstructions(PATHS) };
      }),
    updateBotInstructions: (instructions) =>
      Effect.sync(() => {
        state.botUpdates.push(instructions);
        state.bot = { instructions };
      }),
    getRoutine: (routineId) =>
      Effect.sync(() => Option.fromNullishOr(state.routines.get(routineId))),
    createRoutine: (input) =>
      Effect.sync(() => {
        if (!state.routines.has(input.routineId))
          state.routines.set(input.routineId, routineRow(input));
      }),
    removeRoutine: (routineId) =>
      Effect.sync(() => {
        state.removed.push(routineId);
        state.routines.delete(routineId);
      }),
    registerPreparer: (routineId, preparer) =>
      Effect.sync(() => void state.preparers.set(routineId, preparer)),
    readFile: (path) => Effect.sync(() => Option.fromNullishOr(state.files.get(path))),
    writeFile: (path, text) => Effect.sync(() => void state.files.set(path, text)),
  };
  const reviewState = () => parseReviewState(state.meta.get(CLAUDE_CODE_REVIEW_STATE_KEY) ?? null);
  return { state, deps, reviewState };
};

/** A harness that is already set up (bot and both routines) with P1-P5 open. */
const readyHarness = () => {
  const harness = makeHarness();
  harness.state.meta.set(CLAUDE_CODE_REVIEW_SETUP_KEY, "2");
  harness.state.meta.set(
    CLAUDE_CODE_REVIEW_STATE_KEY,
    JSON.stringify({ reviewedClaudeCode: "2.1.281", reviewedSdk: "0.3.281" }),
  );
  harness.state.files.set(LEDGER, serializeLedger(seededLedger()));
  return harness;
};

const nightlyRoutine = () =>
  ({
    routineId: UPDATES_NIGHTLY_ROUTINE_ID,
    prompt: "NIGHTLY PROMPT",
  }) as PersonalRoutine;

/** 04:00 London on 25 Sep 2026 (BST). */
const AT_0400 = Date.parse("2026-09-25T03:00:00Z");

const runData = (prepared: PersonalRoutineService.PersonalRoutinePrepared) => {
  assert.strictEqual(prepared._tag, "Run");
  if (prepared._tag !== "Run") throw new Error("not a run");
  const match = /## Run data\n\n```json\n([\s\S]*)\n```$/.exec(prepared.objective);
  assert.ok(match !== null, "the objective ends with the run data block");
  assert.ok(prepared.objective.startsWith("NIGHTLY PROMPT"));
  return JSON.parse(match![1]!) as Record<string, any>;
};

const fakeTask = { taskId: PersonalTaskId.make("task-1") } as PersonalTask;

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

it.effect("asks the CLI for the installed version only when the provider snapshot has none", () =>
  Effect.gen(function* () {
    let cliCalls = 0;
    const cli = Effect.sync(() => {
      cliCalls += 1;
      return "2.1.281";
    });
    assert.strictEqual(
      yield* installedVersionWithFallback(Effect.succeed("2.1.280"), cli),
      "2.1.280",
    );
    assert.strictEqual(cliCalls, 0);
    assert.strictEqual(yield* installedVersionWithFallback(Effect.succeed(null), cli), "2.1.281");
    assert.strictEqual(cliCalls, 1);
    assert.strictEqual(
      yield* installedVersionWithFallback(Effect.succeed(null), Effect.succeed(null)),
      null,
    );
  }),
);

it("names a scheduled run after its London slot and a manual one after now, marked dry", () => {
  assert.strictEqual(nightlyRunId(AT_0400, "2026-09-25T04:00", false), "20260925-0400");
  assert.strictEqual(
    nightlyRunId(Date.parse("2026-09-24T21:15:07Z"), "manual:abc", true),
    "20260924-221507-dry",
  );
});

// ── Setup ──────────────────────────────────────────────────────────────

it.effect("fresh setup: the bot, a daily 04:00 London routine and the report relay", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    yield* service.setup;
    assert.strictEqual(state.botsCreated, 1);
    const nightly = state.routines.get(UPDATES_NIGHTLY_ROUTINE_ID)!;
    assert.deepStrictEqual(nightly.schedule, { kind: "daily", time: "04:00" });
    assert.strictEqual(nightly.timeZone, "Europe/London");
    assert.strictEqual(nightly.trigger, "schedule");
    assert.strictEqual(nightly.delivery, "model");
    const report = state.routines.get(UPDATES_REPORT_ROUTINE_ID)!;
    assert.strictEqual(report.trigger, "event");
    assert.strictEqual(report.delivery, "relay");
    assert.strictEqual(state.meta.get(CLAUDE_CODE_REVIEW_SETUP_KEY), "2");
    // The pipeline posts its report with this token.
    assert.strictEqual(state.files.get(`${HOME}/report-hook-token`), "report-token-1");
    // Once only.
    yield* service.setup;
    assert.strictEqual(state.botsCreated, 1);
  }),
);

it.effect(
  "from 1.33.0: untouched instructions replaced, the event routine replaced by the nightly one",
  () =>
    Effect.gen(function* () {
      const { state, deps } = makeHarness();
      state.meta.set(CLAUDE_CODE_REVIEW_SETUP_KEY, "1");
      state.bot = { instructions: legacyUpdatesBotInstructions(PATHS) };
      state.routines.set(LEGACY_UPDATES_ROUTINE_ID, {
        routineId: LEGACY_UPDATES_ROUTINE_ID,
      } as PersonalRoutine);
      const service = yield* makeWith(deps);
      yield* service.setup;
      assert.strictEqual(state.botsCreated, 0);
      assert.deepStrictEqual(state.botUpdates, [updatesBotInstructions(PATHS)]);
      assert.ok(!state.bot!.instructions.includes("Report and propose only"));
      assert.deepStrictEqual(state.removed, [LEGACY_UPDATES_ROUTINE_ID]);
      assert.ok(state.routines.has(UPDATES_NIGHTLY_ROUTINE_ID));
      assert.ok(state.routines.has(UPDATES_REPORT_ROUTINE_ID));
      assert.strictEqual(state.meta.get(CLAUDE_CODE_REVIEW_SETUP_KEY), "2");
    }),
);

it.effect("from 1.33.0: instructions the user edited are kept", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.meta.set(CLAUDE_CODE_REVIEW_SETUP_KEY, "1");
    state.bot = { instructions: "my own words" };
    const service = yield* makeWith(deps);
    yield* service.setup;
    assert.deepStrictEqual(state.botUpdates, []);
    assert.ok(state.routines.has(UPDATES_NIGHTLY_ROUTINE_ID));
  }),
);

it.effect("a bot the user deleted is not recreated, and gets no routines", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.meta.set(CLAUDE_CODE_REVIEW_SETUP_KEY, "1");
    const service = yield* makeWith(deps);
    yield* service.setup;
    assert.strictEqual(state.botsCreated, 0);
    assert.strictEqual(state.routines.size, 0);
    assert.strictEqual(state.meta.get(CLAUDE_CODE_REVIEW_SETUP_KEY), "2");
  }),
);

it.effect("a regenerated report hook token reaches the pipeline's file on the next start", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    yield* service.setup;
    state.routines.set(UPDATES_REPORT_ROUTINE_ID, {
      ...state.routines.get(UPDATES_REPORT_ROUTINE_ID)!,
      hookToken: "report-token-2",
    });
    yield* service.setup;
    assert.strictEqual(state.files.get(`${HOME}/report-hook-token`), "report-token-2");
  }),
);

it.effect("the preparer is registered when enabled, never when disabled", () =>
  Effect.gen(function* () {
    const enabled = makeHarness();
    yield* makeWith(enabled.deps);
    assert.ok(enabled.state.preparers.has(UPDATES_NIGHTLY_ROUTINE_ID));
    const disabled = makeHarness();
    const service = yield* makeWith({ ...disabled.deps, enabled: false });
    assert.strictEqual(disabled.state.preparers.size, 0);
    yield* Effect.scoped(service.start());
    assert.strictEqual(disabled.state.botsCreated, 0);
  }),
);

// ── The 04:00 run ─────────────────────────────────────────────────────

it.effect(
  "04:00 with new releases: one batched review of everything since the last one, plus carry-over",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(AT_0400);
      const { state, deps, reviewState } = readyHarness();
      state.npmCli = "2.1.283";
      state.npmSdk = "0.3.283";
      state.cliVersions = ["2.1.283", "2.1.282", ...state.cliVersions];
      state.sdkVersions = ["0.3.283", "0.3.282", ...state.sdkVersions];
      const service = yield* makeWith(deps);
      const prepared = yield* service.prepareRun({
        routine: nightlyRoutine(),
        localOccurrence: "2026-09-25T04:00",
        manual: false,
      });
      const data = runData(prepared);
      assert.deepStrictEqual(data.run, {
        id: "20260925-0400",
        mode: "live",
        trigger: "schedule",
        startedAt: "2026-09-25T03:00:00.000Z",
      });
      assert.strictEqual(data.review.claudeCode.after, "2.1.281");
      assert.strictEqual(data.review.claudeCode.upTo, "2.1.283");
      assert.strictEqual(data.review.claudeCode.releasesWithNotes, 2);
      assert.strictEqual(data.review.reportFile, "C:/notes/claude-code-updates/2.1.283.md");
      const excerpt = state.files.get(data.review.changelogExcerpt)!;
      assert.ok(excerpt.includes("Change in 2.1.282") && excerpt.includes("Change in 2.1.283"));
      assert.ok(!excerpt.includes("Change in 2.1.281"));
      assert.deepStrictEqual(
        data.proposals.actionable.map((entry: { id: string }) => entry.id),
        ["P1", "P2", "P3", "P4", "P5"],
      );
      assert.ok(
        data.commands.preflight.includes("-Step preflight -RunId 20260925-0400 -Mode Live"),
      );
      assert.ok(
        data.commands.ship.includes(
          "-Step ship -RunId 20260925-0400 -Mode Live -ReviewLabel 2.1.283",
        ),
      );
      assert.ok(data.commands.ledger.includes("scripts/personal/updates/ledger.ts"));
      // Reviewed only once the task exists.
      assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.281");
      assert.strictEqual(prepared._tag === "Run" && prepared.onStarted !== undefined, true);
      if (prepared._tag === "Run") yield* prepared.onStarted!(fakeTask);
      assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.283");
      assert.strictEqual(reviewState().reviewedSdk, "0.3.283");
    }),
);

it.effect("04:00 with no new release still runs the carried-over proposals", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { deps, reviewState } = readyHarness();
    const service = yield* makeWith(deps);
    const prepared = yield* service.prepareRun({
      routine: nightlyRoutine(),
      localOccurrence: "2026-09-25T04:00",
      manual: false,
    });
    const data = runData(prepared);
    assert.strictEqual(data.review, null);
    assert.strictEqual(data.reviewSkipped, "no new Claude Code or Agent SDK release");
    assert.strictEqual(data.proposals.actionable.length, 5);
    assert.ok(!data.commands.ship.includes("-ReviewLabel"));
    assert.strictEqual(prepared._tag === "Run" && prepared.onStarted === undefined, true);
    // The check itself is stamped.
    assert.strictEqual(reviewState().lastCheckedAt, "2026-09-25T03:00:00.000Z");
  }),
);

it.effect("risky and decided proposals wait for approval; approved ones carry over", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { state, deps } = readyHarness();
    let ledger = seededLedger();
    ledger = decideProposal(ledger, "P4", "risky", "UI change", "t", "r0");
    ledger = decideProposal(ledger, "P5", "risky", "needs P1", "t", "r0");
    state.files.set(LEDGER, serializeLedger(ledger));
    const service = yield* makeWith(deps);
    const data = runData(
      yield* service.prepareRun({
        routine: nightlyRoutine(),
        localOccurrence: "2026-09-25T04:00",
        manual: false,
      }),
    );
    assert.deepStrictEqual(
      data.proposals.actionable.map((entry: { id: string }) => entry.id),
      ["P1", "P2", "P3"],
    );
    assert.deepStrictEqual(
      data.proposals.awaitingApproval.map((entry: { id: string }) => entry.id),
      ["P4", "P5"],
    );
  }),
);

it.effect("nothing new and nothing carried over: the slot is skipped, no task", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { state, deps } = readyHarness();
    state.files.delete(LEDGER);
    const service = yield* makeWith(deps);
    const prepared = yield* service.prepareRun({
      routine: nightlyRoutine(),
      localOccurrence: "2026-09-25T04:00",
      manual: false,
    });
    assert.deepStrictEqual(prepared, {
      _tag: "Skip",
      reason: "no new Claude Code or Agent SDK release, and no open or approved proposals",
    });
  }),
);

it.effect("a slot caught up after 06:00 (the laptop slept) is skipped, never run in the day", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-25T08:30:00Z"));
    const { state, deps } = readyHarness();
    const service = yield* makeWith(deps);
    const prepared = yield* service.prepareRun({
      routine: nightlyRoutine(),
      localOccurrence: "2026-09-25T04:00",
      manual: false,
    });
    assert.strictEqual(prepared._tag, "Skip");
    assert.ok(prepared._tag === "Skip" && prepared.reason.includes("missed the night window"));
    assert.strictEqual(state.fetched.length, 0);
  }),
);

it.effect("Run now is a dry run: any time of day, report in the run folder, nothing recorded", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-24T21:15:07Z"));
    const { state, deps, reviewState } = readyHarness();
    state.npmCli = "2.1.282";
    state.cliVersions = ["2.1.282", ...state.cliVersions];
    const service = yield* makeWith(deps);
    const prepared = yield* service.prepareRun({
      routine: nightlyRoutine(),
      localOccurrence: "manual:abc",
      manual: true,
    });
    const data = runData(prepared);
    assert.strictEqual(data.run.id, "20260924-221507-dry");
    assert.strictEqual(data.run.mode, "dry-run");
    assert.strictEqual(data.review.reportFile, `${HOME}/runs/20260924-221507-dry/2.1.282.md`);
    assert.ok(data.commands.preflight.includes("-Mode DryRun"));
    assert.strictEqual(prepared._tag === "Run" && prepared.onStarted === undefined, true);
    assert.deepStrictEqual(reviewState(), {
      reviewedClaudeCode: "2.1.281",
      reviewedSdk: "0.3.281",
      lastCheckedAt: null,
      lastReview: null,
    });
  }),
);

it.effect("offline registry: the carried-over proposals still run; nothing is stamped", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { state, deps, reviewState } = readyHarness();
    state.npmCli = null;
    state.npmSdk = null;
    state.installed = null;
    const service = yield* makeWith(deps);
    const data = runData(
      yield* service.prepareRun({
        routine: nightlyRoutine(),
        localOccurrence: "2026-09-25T04:00",
        manual: false,
      }),
    );
    assert.strictEqual(data.reviewSkipped, "the npm registry was unreachable");
    assert.strictEqual(reviewState().lastCheckedAt, null);
  }),
);

it.effect("a corrupt ledger fails the run visibly instead of dropping its proposals", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { state, deps } = readyHarness();
    state.files.set(LEDGER, "{ not json");
    const service = yield* makeWith(deps);
    const exit = yield* Effect.exit(
      service.prepareRun({
        routine: nightlyRoutine(),
        localOccurrence: "2026-09-25T04:00",
        manual: false,
      }),
    );
    assert.ok(Exit.isFailure(exit));
  }),
);

it.effect("a release on npm before its notes waits for them instead of being skipped", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AT_0400);
    const { state, deps, reviewState } = readyHarness();
    state.npmCli = "2.1.282";
    const service = yield* makeWith(deps);
    const data = runData(
      yield* service.prepareRun({
        routine: nightlyRoutine(),
        localOccurrence: "2026-09-25T04:00",
        manual: false,
      }),
    );
    assert.strictEqual(data.reviewSkipped, "a new release has no release notes yet");
    assert.strictEqual(reviewState().reviewedClaudeCode, "2.1.281");
  }),
);

it("the bot's new instructions no longer forbid applying safe proposals", () => {
  const text = updatesBotInstructions(PATHS);
  assert.ok(text.includes("rate SAFE"));
  assert.ok(text.includes("approve P<n>"));
  assert.ok(text.includes("ledger.ts"));
  assert.strictEqual(PersonalBotId.make("personal-claude-code-updates").length > 0, true);
});
