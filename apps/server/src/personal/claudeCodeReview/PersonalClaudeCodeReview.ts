/**
 * PersonalClaudeCodeReview - an automatic review of each new Claude Code /
 * Agent SDK release against hbots.
 *
 * A cheap check (at most once a day; the loop wakes hourly so a sleeping
 * laptop catches up) reads the npm registry and the installed claude.exe
 * version. When either moved past what was last reviewed, it slices the two
 * changelogs to the unreviewed range, writes the excerpt to disk and fires the
 * "Claude Code update review" event routine on the dedicated "Updates" bot.
 * The run is an ordinary routine task: it shows in Tasks, lands in that bot's
 * chat and pushes like any routine result. The bot reports and proposes only.
 *
 * Once per version: the reviewed versions are stored in `personal_meta` when
 * the task starts, never before, so a paused routine or an unreachable
 * registry just means the next check tries again with the whole range.
 *
 * The bot and routine are created once through the normal bot and routine
 * services. Deleting either is respected: nothing is recreated.
 *
 * @module personal/claudeCodeReview/PersonalClaudeCodeReview
 */
import type { PersonalRoutine } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import {
  buildExcerpt,
  CLAUDE_CODE_REVIEW_STATE_KEY,
  decideReview,
  normalizeVersion,
  parseChangelog,
  parseReviewState,
  reviewedThrough,
  sdkParityVersion,
  type ChangelogSection,
  type ClaudeCodeReviewState,
  type ObservedVersions,
} from "./claudeCodeVersions.ts";
import {
  DEFAULT_REVIEW_PATHS,
  reportDir,
  UPDATES_ROUTINE_ID,
  updatesBotCreateInput,
  updatesRoutineCreateInput,
  type ReviewPaths,
} from "./reviewPrompts.ts";

export const CLAUDE_CODE_REVIEW_SETUP_KEY = "claude-code-review:setup";

export const NPM_CLAUDE_CODE_LATEST = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
export const NPM_AGENT_SDK_LATEST =
  "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest";
export const CLAUDE_CODE_CHANGELOG =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
export const AGENT_SDK_CHANGELOG =
  "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md";

/** A day, less a margin so a check that ran a little late yesterday still runs today. */
export const CHECK_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const LOOP_INTERVAL = Duration.hours(1);
/** Lets the server finish starting before the first registry read. */
const FIRST_CHECK_DELAY = Duration.minutes(2);

interface DepFailure {
  readonly _tag?: string;
  readonly message?: string;
}

export interface PersonalClaudeCodeReviewDeps {
  /** Off for servers that are not the user's live Bots (tests, perf probes, QA roots). */
  readonly enabled: boolean;
  readonly paths: ReviewPaths;
  /** Where changelog excerpts are written for the bot to read. */
  readonly excerptDir: string;
  /** The SDK version hbots is built with. */
  readonly pinnedSdk: string | null;
  readonly fetchText: (url: string) => Effect.Effect<string, DepFailure>;
  readonly installedClaudeCode: Effect.Effect<string | null>;
  readonly getMeta: (key: string) => Effect.Effect<Option.Option<string>, DepFailure>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, DepFailure>;
  readonly createBot: () => Effect.Effect<void, DepFailure>;
  readonly createRoutine: () => Effect.Effect<void, DepFailure>;
  readonly getRoutine: () => Effect.Effect<Option.Option<PersonalRoutine>>;
  readonly fireEvent: (
    input: PersonalRoutineService.PersonalRoutineFireEventInput,
  ) => Effect.Effect<PersonalRoutineService.PersonalRoutineFireEventResult>;
  readonly writeFile: (path: string, text: string) => Effect.Effect<void, DepFailure>;
}

export type ClaudeCodeReviewCheckResult =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "Throttled" }
  | { readonly _tag: "Unreachable" }
  | { readonly _tag: "UpToDate" }
  | { readonly _tag: "Baseline" }
  | { readonly _tag: "RoutineUnavailable" }
  | { readonly _tag: "ChangelogPending" }
  | { readonly _tag: "FireFailed" }
  | {
      readonly _tag: "Fired";
      readonly taskId: string;
      readonly claudeCode: string | null;
      readonly sdk: string | null;
      readonly excerptPath: string;
      readonly reportPath: string;
    };

export interface PersonalClaudeCodeReviewShape {
  /** First check two minutes after activation, then an hourly wake-up (daily at most). */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** One check. `force` skips the daily throttle (not the once-per-version rule). */
  readonly check: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<ClaudeCodeReviewCheckResult>;
}

export class PersonalClaudeCodeReview extends Context.Service<
  PersonalClaudeCodeReview,
  PersonalClaudeCodeReviewShape
>()("t3/personal/claudeCodeReview/PersonalClaudeCodeReview") {}

const describe = (error: DepFailure) => error.message ?? error._tag ?? String(error);

/** `version` from an npm `/latest` document, or null. */
export function npmLatestVersion(body: string): string | null {
  try {
    const value = JSON.parse(body) as { readonly version?: unknown };
    return typeof value.version === "string" ? normalizeVersion(value.version) : null;
  } catch {
    return null;
  }
}

/** @public Service construction with explicit dependencies; `layer` wires the real ones. */
export const makeWith = (deps: PersonalClaudeCodeReviewDeps) =>
  Effect.gen(function* () {
    // One check at a time: the startup check and the hourly wake-up never overlap.
    const lock = yield* Semaphore.make(1);

    const saveState = (state: ClaudeCodeReviewState) =>
      deps.setMeta(CLAUDE_CODE_REVIEW_STATE_KEY, JSON.stringify(state));

    const fetchOptional = (url: string) =>
      deps.fetchText(url).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning("claude code review could not fetch", {
            url,
            error: describe(error),
          }).pipe(Effect.as(Option.none<string>())),
        ),
      );

    /** Creates the Updates bot and its routine the first time only. */
    const ensureSetup = Effect.gen(function* () {
      const done = yield* deps.getMeta(CLAUDE_CODE_REVIEW_SETUP_KEY);
      if (Option.isSome(done)) return;
      yield* deps.createBot();
      yield* deps.createRoutine();
      yield* deps.setMeta(CLAUDE_CODE_REVIEW_SETUP_KEY, "1");
      yield* Effect.logInfo("claude code review set up the Updates bot and its routine");
    });

    const runCheck = (force: boolean) =>
      Effect.gen(function* () {
        if (!deps.enabled) return { _tag: "Disabled" } as const;
        yield* ensureSetup;
        const state = parseReviewState(
          Option.getOrNull(yield* deps.getMeta(CLAUDE_CODE_REVIEW_STATE_KEY)),
        );
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const nowIso = DateTime.formatIso(now);
        if (
          !force &&
          state.lastCheckedAt !== null &&
          nowMs - Date.parse(state.lastCheckedAt) < CHECK_MIN_INTERVAL_MS
        ) {
          return { _tag: "Throttled" } as const;
        }

        const latestClaudeCode = Option.getOrNull(
          Option.flatMap(yield* fetchOptional(NPM_CLAUDE_CODE_LATEST), (body) =>
            Option.fromNullishOr(npmLatestVersion(body)),
          ),
        );
        const latestSdk = Option.getOrNull(
          Option.flatMap(yield* fetchOptional(NPM_AGENT_SDK_LATEST), (body) =>
            Option.fromNullishOr(npmLatestVersion(body)),
          ),
        );
        const installedClaudeCode = normalizeVersion(yield* deps.installedClaudeCode);
        if (latestClaudeCode === null && latestSdk === null && installedClaudeCode === null) {
          // Nothing to compare against; not stamped, so the next hourly wake-up retries.
          return { _tag: "Unreachable" } as const;
        }

        // The SDK changelog is small; it is needed for the first review's
        // starting point and for every review's SDK section.
        let sdkSections: ReadonlyArray<ChangelogSection> | null = null;
        const loadSdkSections = Effect.gen(function* () {
          if (sdkSections === null) {
            const body = yield* fetchOptional(AGENT_SDK_CHANGELOG);
            sdkSections = Option.isSome(body) ? parseChangelog(body.value) : [];
          }
          return sdkSections;
        });

        const pinnedSdkParityClaudeCode =
          state.reviewedClaudeCode === null && deps.pinnedSdk !== null
            ? sdkParityVersion(yield* loadSdkSections, deps.pinnedSdk)
            : null;
        const observed: ObservedVersions = {
          latestClaudeCode,
          installedClaudeCode,
          latestSdk,
          pinnedSdk: deps.pinnedSdk,
          pinnedSdkParityClaudeCode,
        };
        const stamped: ClaudeCodeReviewState = { ...state, lastCheckedAt: nowIso };
        const decision = decideReview(state, observed);

        if (decision._tag === "UpToDate") {
          yield* saveState(stamped);
          return { _tag: "UpToDate" } as const;
        }
        if (decision._tag === "Baseline") {
          yield* saveState({
            ...stamped,
            reviewedClaudeCode: decision.claudeCode,
            reviewedSdk: decision.sdk,
          });
          yield* Effect.logInfo("claude code review recorded a baseline", {
            claudeCode: decision.claudeCode,
            sdk: decision.sdk,
          });
          return { _tag: "Baseline" } as const;
        }

        const routine = Option.getOrNull(yield* deps.getRoutine());
        if (routine === null || !routine.enabled || routine.hookToken === null) {
          // Paused or deleted by the user: nothing is recorded, so resuming it
          // later reviews the whole range then.
          yield* saveState(stamped);
          yield* Effect.logInfo("claude code review skipped: its routine is paused or gone");
          return { _tag: "RoutineUnavailable" } as const;
        }

        let claudeCodeSections: ReadonlyArray<ChangelogSection> = [];
        if (decision.claudeCode !== null) {
          const body = yield* fetchOptional(CLAUDE_CODE_CHANGELOG);
          // Retry within the hour rather than review without the main changelog.
          if (Option.isNone(body)) return { _tag: "Unreachable" } as const;
          claudeCodeSections = parseChangelog(body.value);
        }
        const excerpt = buildExcerpt({
          claudeCode: decision.claudeCode,
          sdk: decision.sdk,
          claudeCodeSections,
          sdkSections: decision.sdk === null ? [] : yield* loadSdkSections,
          observed,
          generatedAt: nowIso,
        });
        if (excerpt.claudeCodeVersions.length === 0 && excerpt.sdkVersions.length === 0) {
          // On npm, but no release notes published yet: try again tomorrow.
          yield* saveState(stamped);
          return { _tag: "ChangelogPending" } as const;
        }

        const reviewedClaudeCode = reviewedThrough(
          state.reviewedClaudeCode,
          decision.claudeCode,
          excerpt.claudeCodeVersions,
        );
        const reviewedSdk = reviewedThrough(state.reviewedSdk, decision.sdk, excerpt.sdkVersions);
        const label = reviewedClaudeCode ?? reviewedSdk ?? "unknown";
        const excerptPath = `${deps.excerptDir}/changelog-${label}.md`;
        const reportPath = `${reportDir(deps.paths)}/${label}.md`;
        yield* deps.writeFile(excerptPath, excerpt.markdown);

        const payload = {
          review: "Claude Code update review",
          claudeCode:
            decision.claudeCode === null
              ? null
              : {
                  after: decision.claudeCode.from,
                  upTo: decision.claudeCode.to,
                  releasesWithNotes: excerpt.claudeCodeVersions.length,
                  condensedOlderReleases: excerpt.condensedVersions.length,
                },
          agentSdk:
            decision.sdk === null
              ? null
              : {
                  after: decision.sdk.from,
                  upTo: decision.sdk.to,
                  releasesWithNotes: excerpt.sdkVersions.length,
                },
          installedClaudeCode,
          npmLatestClaudeCode: latestClaudeCode,
          pinnedAgentSdk: deps.pinnedSdk,
          npmLatestAgentSdk: latestSdk,
          changelogExcerpt: excerptPath,
          reportFile: reportPath,
          hbotsSource: deps.paths.repoDir,
        };
        const fired = yield* deps.fireEvent({
          hookToken: routine.hookToken,
          contentType: "application/json",
          // @effect-diagnostics-next-line preferSchemaOverJson:off - a free-form event body the bot reads as data.
          body: JSON.stringify(payload),
        });
        if (fired._tag !== "Fired") {
          yield* saveState(stamped);
          yield* Effect.logWarning("claude code review could not start its task", {
            result: fired._tag,
          });
          return { _tag: "FireFailed" } as const;
        }
        yield* saveState({
          ...stamped,
          reviewedClaudeCode,
          reviewedSdk,
          lastReview: {
            claudeCode: label,
            sdk: reviewedSdk,
            taskId: fired.taskId,
            firedAt: nowIso,
          },
        });
        yield* Effect.logInfo("claude code review started", {
          taskId: fired.taskId,
          claudeCode: decision.claudeCode,
          sdk: decision.sdk,
          excerptPath,
        });
        return {
          _tag: "Fired",
          taskId: fired.taskId,
          claudeCode: reviewedClaudeCode,
          sdk: reviewedSdk,
          excerptPath,
          reportPath,
        } as const;
      });

    const check: PersonalClaudeCodeReviewShape["check"] = (options) =>
      lock.withPermit(runCheck(options?.force === true)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("claude code review check failed", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as({ _tag: "FireFailed" } as const)),
        ),
      );

    const start: PersonalClaudeCodeReviewShape["start"] = () =>
      deps.enabled
        ? forkParked(
            Effect.sleep(FIRST_CHECK_DELAY).pipe(
              Effect.andThen(
                check().pipe(Effect.repeat(Schedule.spaced(LOOP_INTERVAL)), Effect.asVoid),
              ),
            ),
          ).pipe(Effect.asVoid)
        : Effect.void;

    return { start, check } satisfies PersonalClaudeCodeReviewShape;
  });

/**
 * On for the supervised live server only: `start.ps1` labels it "Bots".
 * PB_CLAUDE_CODE_REVIEW=1 / 0 forces it on or off.
 */
export function claudeCodeReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PB_CLAUDE_CODE_REVIEW;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return env.T3CODE_ENVIRONMENT_LABEL === "Bots";
}

const fetchText = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      // @effect-diagnostics-next-line globalFetchInEffect:off - two public GETs a day (npm registry, GitHub raw), bounded timeout.
      const response = await fetch(url, {
        headers: { "user-agent": "hbots-claude-code-review" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      return await response.text();
    },
    catch: (cause) => ({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const paths = DEFAULT_REVIEW_PATHS;
  return yield* makeWith({
    enabled: claudeCodeReviewEnabled(process.env),
    paths,
    excerptDir: path.join(config.stateDir, "claude-code-updates").replaceAll("\\", "/"),
    pinnedSdk: normalizeVersion(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"]),
    fetchText,
    installedClaudeCode: providers.getProviders.pipe(
      Effect.map(
        (list) => list.find((provider) => provider.driver === "claudeAgent")?.version ?? null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    ),
    getMeta: (key) => repository.getMeta({ key }),
    setMeta: (key, value) => repository.setMeta({ key, value }),
    createBot: () => bots.create(updatesBotCreateInput(paths)).pipe(Effect.asVoid),
    createRoutine: () => routines.create(updatesRoutineCreateInput(paths)).pipe(Effect.asVoid),
    getRoutine: () =>
      routines.get({ routineId: UPDATES_ROUTINE_ID }).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<PersonalRoutine>()),
      ),
    fireEvent: routines.fireEvent,
    writeFile: (file, text) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text))),
  });
});

export const layer = Layer.effect(PersonalClaudeCodeReview, make);
