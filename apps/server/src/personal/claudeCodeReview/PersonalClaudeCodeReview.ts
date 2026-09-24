/**
 * PersonalClaudeCodeReview - the nightly Claude Code update run on the
 * dedicated "Updates" bot.
 *
 * Every day at 04:00 London the "Claude Code nightly update" routine (an
 * ordinary scheduled routine: Tasks > Scheduled shows it, pausing it stops the
 * runs) starts a task. This module prepares each run just before it starts
 * (PersonalRoutineService preparer):
 * - it reads the npm registry and the installed claude.exe version, and when
 *   either moved past what was last reviewed it slices the two changelogs to
 *   the unreviewed range (every release since the last review, in one run)
 *   and writes the excerpt to disk;
 * - it reads the proposal ledger: undecided and approved proposals from
 *   earlier reviews carry over into the run;
 * - with nothing new and nothing carried over, the slot is skipped silently.
 * The bot then reviews, applies what it rates safe and hands off to the ship
 * pipeline (scripts/personal/updates/), which gates, builds, restarts,
 * verifies, rolls back if needed and posts the morning report through the
 * "Morning report" relay routine.
 *
 * "Run now" from the app is a dry run: the same steps in a throwaway worktree,
 * stopping before push and restart. It records nothing (no reviewed versions,
 * a copy of the ledger).
 *
 * Once per version: reviewed versions are stored in `personal_meta` when a
 * live run's task starts, never before.
 *
 * The bot and routines are created once through the normal bot and routine
 * services; deleting either is respected: nothing is recreated.
 *
 * @module personal/claudeCodeReview/PersonalClaudeCodeReview
 */
// @effect-diagnostics preferSchemaOverJson:off - the run data is free-form JSON the bot reads.
import type {
  PersonalRoutine,
  PersonalRoutineCreateInput,
  PersonalRoutineId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as NodeOS from "node:os";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { runClaudeCommand } from "../../provider/Layers/ClaudeProvider.ts";
import { parseGenericCliVersion } from "../../provider/providerSnapshot.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import { localAt } from "../routines/zonedTime.ts";
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
import { actionableProposals, awaitingApproval, parseLedger } from "./proposalLedger.ts";
import {
  DEFAULT_REVIEW_PATHS,
  LEGACY_UPDATES_ROUTINE_ID,
  ledgerPath,
  legacyUpdatesBotInstructions,
  NIGHTLY_LATEST_START_HOUR,
  NIGHTLY_TIME_ZONE,
  reportDir,
  UPDATES_BOT_DESCRIPTION,
  UPDATES_NIGHTLY_ROUTINE_ID,
  UPDATES_REPORT_ROUTINE_ID,
  updatesBotCreateInput,
  updatesBotInstructions,
  updatesNightlyRoutineCreateInput,
  updatesReportRoutineCreateInput,
  updatesScript,
  type ReviewPaths,
} from "./reviewPrompts.ts";

export const CLAUDE_CODE_REVIEW_SETUP_KEY = "claude-code-review:setup";
/** Setup "1" was 1.33.0's event routine; "2" is the nightly run. */
export const CLAUDE_CODE_REVIEW_SETUP_VERSION = "2";

export const NPM_CLAUDE_CODE_LATEST = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
export const NPM_AGENT_SDK_LATEST =
  "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest";
export const CLAUDE_CODE_CHANGELOG =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
export const AGENT_SDK_CHANGELOG =
  "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md";

interface DepFailure {
  readonly _tag?: string;
  readonly message?: string;
}

export interface UpdatesBotSnapshot {
  readonly instructions: string;
}

export interface PersonalClaudeCodeReviewDeps {
  /** Off for servers that are not the user's live Bots (tests, perf probes, QA roots). */
  readonly enabled: boolean;
  readonly paths: ReviewPaths;
  /** Where changelog excerpts are written for the bot to read. */
  readonly excerptDir: string;
  /** The ship pipeline's home: runs, lock, the report hook token. */
  readonly updatesHome: string;
  /** The SDK version hbots is built with. */
  readonly pinnedSdk: string | null;
  readonly fetchText: (url: string) => Effect.Effect<string, DepFailure>;
  readonly installedClaudeCode: Effect.Effect<string | null>;
  readonly getMeta: (key: string) => Effect.Effect<Option.Option<string>, DepFailure>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, DepFailure>;
  readonly getBot: () => Effect.Effect<Option.Option<UpdatesBotSnapshot>, DepFailure>;
  readonly createBot: () => Effect.Effect<void, DepFailure>;
  readonly updateBotInstructions: (
    instructions: string,
    description: string,
  ) => Effect.Effect<void, DepFailure>;
  readonly getRoutine: (
    routineId: PersonalRoutineId,
  ) => Effect.Effect<Option.Option<PersonalRoutine>>;
  readonly createRoutine: (input: PersonalRoutineCreateInput) => Effect.Effect<void, DepFailure>;
  readonly removeRoutine: (routineId: PersonalRoutineId) => Effect.Effect<void, DepFailure>;
  readonly registerPreparer: (
    routineId: PersonalRoutineId,
    preparer: PersonalRoutineService.PersonalRoutinePreparer,
  ) => Effect.Effect<void>;
  readonly readFile: (path: string) => Effect.Effect<Option.Option<string>>;
  readonly writeFile: (path: string, text: string) => Effect.Effect<void, DepFailure>;
}

export interface PersonalClaudeCodeReviewShape {
  /** Setup (once) and the report hook token file (every start). */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly setup: Effect.Effect<void, DepFailure>;
  /** The nightly routine's preparer (registered at construction when enabled). */
  readonly prepareRun: PersonalRoutineService.PersonalRoutinePreparer;
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

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The run's id: the London date and time of the slot (`20260925-0400`), and
 * for a manual dry run the moment it was started plus `-dry`.
 */
export function nightlyRunId(nowMs: number, localOccurrence: string, manual: boolean): string {
  const slot = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localOccurrence);
  if (!manual && slot !== null) {
    return `${slot[1]}${slot[2]}${slot[3]}-${slot[4]}${slot[5]}`;
  }
  const local = localAt(nowMs, NIGHTLY_TIME_ZONE);
  // @effect-diagnostics-next-line globalDate:off - seconds of an epoch instant, only to keep manual ids unique.
  const seconds = new Date(nowMs).getUTCSeconds();
  return `${local.year}${pad(local.month)}${pad(local.day)}-${pad(local.hour)}${pad(local.minute)}${pad(seconds)}-dry`;
}

export type RunMode = "live" | "dry-run";

/** The commands the bot runs; the pipeline scripts do everything that can hurt. */
export function nightlyCommands(
  paths: ReviewPaths,
  runId: string,
  mode: RunMode,
  review: { readonly label: string; readonly reportFile: string } | null,
) {
  const script = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${updatesScript(paths, "nightly.ps1")}"`;
  const common = `-RunId ${runId} -Mode ${mode === "live" ? "Live" : "DryRun"}`;
  const reviewArgs =
    review === null ? "" : ` -ReviewLabel ${review.label} -ReviewReport "${review.reportFile}"`;
  return {
    preflight: `${script} -Step preflight ${common}`,
    ship: `${script} -Step ship ${common}${reviewArgs}`,
    // --run ties every decision the bot records to this run: the pipeline
    // reverts or ships exactly what this run applied.
    ledger: `node "${updatesScript(paths, "ledger.ts")}" --run ${runId}`,
  };
}

type ReviewPlan =
  | { readonly _tag: "None"; readonly reason: string }
  | {
      readonly _tag: "Review";
      readonly label: string;
      readonly data: Record<string, unknown>;
      readonly reviewedState: ClaudeCodeReviewState;
    };

/** @public Service construction with explicit dependencies; `layer` wires the real ones. */
export const makeWith = (deps: PersonalClaudeCodeReviewDeps) =>
  Effect.gen(function* () {
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

    /**
     * What the run reviews: every release since the last review, batched. A
     * live run stamps the check (and a first-ever baseline); a dry run writes
     * nothing but the excerpt.
     */
    const planReview = (options: {
      readonly persist: boolean;
      readonly reportDirectory: string;
      readonly nowIso: string;
    }) =>
      Effect.gen(function* () {
        const state = parseReviewState(
          Option.getOrNull(yield* deps.getMeta(CLAUDE_CODE_REVIEW_STATE_KEY)),
        );
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
          return { _tag: "None", reason: "the npm registry was unreachable" } as ReviewPlan;
        }
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
        const stamped: ClaudeCodeReviewState = { ...state, lastCheckedAt: options.nowIso };
        const decision = decideReview(state, observed);
        if (decision._tag === "UpToDate") {
          if (options.persist) yield* saveState(stamped);
          return { _tag: "None", reason: "no new Claude Code or Agent SDK release" } as ReviewPlan;
        }
        if (decision._tag === "Baseline") {
          if (options.persist) {
            yield* saveState({
              ...stamped,
              reviewedClaudeCode: decision.claudeCode,
              reviewedSdk: decision.sdk,
            });
          }
          return { _tag: "None", reason: "recorded a first baseline" } as ReviewPlan;
        }
        let claudeCodeSections: ReadonlyArray<ChangelogSection> = [];
        if (decision.claudeCode !== null) {
          const body = yield* fetchOptional(CLAUDE_CODE_CHANGELOG);
          // Not stamped: the next night retries with the whole range.
          if (Option.isNone(body)) {
            return {
              _tag: "None",
              reason: "the Claude Code changelog was unreachable",
            } as ReviewPlan;
          }
          claudeCodeSections = parseChangelog(body.value);
        }
        const excerpt = buildExcerpt({
          claudeCode: decision.claudeCode,
          sdk: decision.sdk,
          claudeCodeSections,
          sdkSections: decision.sdk === null ? [] : yield* loadSdkSections,
          observed,
          generatedAt: options.nowIso,
        });
        if (excerpt.claudeCodeVersions.length === 0 && excerpt.sdkVersions.length === 0) {
          if (options.persist) yield* saveState(stamped);
          return { _tag: "None", reason: "a new release has no release notes yet" } as ReviewPlan;
        }
        const reviewedClaudeCode = reviewedThrough(
          state.reviewedClaudeCode,
          decision.claudeCode,
          excerpt.claudeCodeVersions,
        );
        const reviewedSdk = reviewedThrough(state.reviewedSdk, decision.sdk, excerpt.sdkVersions);
        const label = reviewedClaudeCode ?? reviewedSdk ?? "unknown";
        const excerptPath = `${deps.excerptDir}/changelog-${label}.md`;
        yield* deps.writeFile(excerptPath, excerpt.markdown);
        return {
          _tag: "Review",
          label,
          reviewedState: { ...stamped, reviewedClaudeCode, reviewedSdk },
          data: {
            label,
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
            reportFile: `${options.reportDirectory}/${label}.md`,
          },
        } as ReviewPlan;
      });

    const prepareRun: PersonalRoutineService.PersonalRoutinePreparer = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const nowIso = DateTime.formatIso(now);
        const manual = input.manual;
        const mode: RunMode = manual ? "dry-run" : "live";
        if (!manual) {
          const local = localAt(nowMs, NIGHTLY_TIME_ZONE);
          if (local.hour >= NIGHTLY_LATEST_START_HOUR) {
            return {
              _tag: "Skip",
              reason: `missed the night window (the laptop was asleep or off; it is ${pad(local.hour)}:${pad(local.minute)}). The next run is at 04:00`,
            } as const;
          }
        }
        const runId = nightlyRunId(nowMs, input.localOccurrence, manual);
        const runDir = `${deps.updatesHome}/runs/${runId}`;
        const ledgerText = Option.getOrNull(yield* deps.readFile(ledgerPath(deps.paths)));
        // A corrupt ledger fails the run visibly (occurrence "failed") rather
        // than silently dropping the proposals it carries.
        // (parseLedger throws a LedgerError; Effect.sync turns it into a defect.)
        const ledger = yield* Effect.sync(() => parseLedger(ledgerText));
        const plan = yield* planReview({
          persist: !manual,
          reportDirectory: manual ? runDir : reportDir(deps.paths),
          nowIso,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              _tag: "None",
              reason: `the release check failed: ${describe(error)}`,
            } as ReviewPlan),
          ),
        );
        const actionable = actionableProposals(ledger);
        if (plan._tag === "None" && actionable.length === 0) {
          yield* Effect.logInfo("claude code nightly run skipped: nothing to do", {
            reason: plan.reason,
          });
          return {
            _tag: "Skip",
            reason: `${plan.reason}, and no open or approved proposals`,
          } as const;
        }
        const review =
          plan._tag === "Review"
            ? { label: plan.label, reportFile: String(plan.data.reportFile) }
            : null;
        const runData = {
          run: {
            id: runId,
            mode,
            trigger: manual ? "manual" : "schedule",
            startedAt: nowIso,
          },
          review: plan._tag === "Review" ? plan.data : null,
          reviewSkipped: plan._tag === "None" ? plan.reason : null,
          proposals: {
            actionable: actionable.map((entry) => ({
              id: entry.id,
              status: entry.status,
              title: entry.title,
              source: entry.source,
              detail: entry.detail,
            })),
            awaitingApproval: awaitingApproval(ledger).map((entry) => ({
              id: entry.id,
              title: entry.title,
              reason: entry.reason,
            })),
          },
          commands: nightlyCommands(deps.paths, runId, mode, review),
          hbotsSource: deps.paths.repoDir,
        };
        const objective = `${input.routine.prompt}\n\n## Run data\n\n\`\`\`json\n${JSON.stringify(runData, null, 2)}\n\`\`\``;
        yield* Effect.logInfo("claude code nightly run prepared", {
          runId,
          mode,
          review: review?.label ?? null,
          actionable: actionable.map((entry) => entry.id),
        });
        return {
          _tag: "Run",
          objective,
          // Reviewed versions are recorded once the live task exists: a run
          // that never started reviews the same range the next night.
          ...(plan._tag === "Review" && !manual
            ? { onStarted: () => saveState(plan.reviewedState).pipe(Effect.ignore) }
            : {}),
        } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.die(
            new Error(`claude code nightly run could not be prepared: ${describe(error)}`),
          ),
        ),
      );

    const tokenFile = `${deps.updatesHome}/report-hook-token`;

    /**
     * Once: the bot, the nightly routine and the report relay. From 1.33.0's
     * setup ("1") the bot's untouched instructions are replaced and the old
     * event routine removed. A bot or routine the user deleted is not
     * recreated. Every start: the pipeline's copy of the report hook token.
     */
    const setup = Effect.gen(function* () {
      const version = Option.getOrNull(yield* deps.getMeta(CLAUDE_CODE_REVIEW_SETUP_KEY));
      if (version !== CLAUDE_CODE_REVIEW_SETUP_VERSION) {
        const bot = yield* deps.getBot();
        let botExists = Option.isSome(bot);
        if (version === null && !botExists) {
          yield* deps.createBot();
          botExists = true;
        } else if (
          Option.isSome(bot) &&
          bot.value.instructions === legacyUpdatesBotInstructions(deps.paths)
        ) {
          yield* deps.updateBotInstructions(
            updatesBotInstructions(deps.paths),
            UPDATES_BOT_DESCRIPTION,
          );
        } else if (Option.isSome(bot)) {
          yield* Effect.logWarning(
            "claude code review kept the Updates bot's edited instructions; the nightly routine's prompt still carries the run steps",
          );
        }
        if (Option.isSome(yield* deps.getRoutine(LEGACY_UPDATES_ROUTINE_ID))) {
          yield* deps.removeRoutine(LEGACY_UPDATES_ROUTINE_ID);
        }
        if (botExists) {
          yield* deps.createRoutine(updatesNightlyRoutineCreateInput(deps.paths));
          yield* deps.createRoutine(updatesReportRoutineCreateInput());
        }
        yield* deps.setMeta(CLAUDE_CODE_REVIEW_SETUP_KEY, CLAUDE_CODE_REVIEW_SETUP_VERSION);
        yield* Effect.logInfo("claude code review set up the nightly update run", {
          from: version,
          botExists,
        });
      }
      const report = yield* deps.getRoutine(UPDATES_REPORT_ROUTINE_ID);
      if (Option.isSome(report) && report.value.hookToken !== null) {
        const current = Option.getOrNull(yield* deps.readFile(tokenFile));
        if (current?.trim() !== report.value.hookToken) {
          yield* deps.writeFile(tokenFile, report.value.hookToken);
        }
      }
    });

    if (deps.enabled) {
      // At construction, before any routine tick can reach a due 04:00 slot.
      yield* deps.registerPreparer(UPDATES_NIGHTLY_ROUTINE_ID, prepareRun);
    }

    const start: PersonalClaudeCodeReviewShape["start"] = () =>
      deps.enabled
        ? forkParked(
            setup.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("claude code review setup failed", {
                      cause: Cause.pretty(cause),
                    }),
              ),
            ),
          ).pipe(Effect.asVoid)
        : Effect.void;

    return { start, setup, prepareRun } satisfies PersonalClaudeCodeReviewShape;
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
      // @effect-diagnostics-next-line globalFetchInEffect:off - a few public GETs a night (npm registry, GitHub raw), bounded timeout.
      const response = await fetch(url, {
        headers: { "user-agent": "hbots-claude-code-review" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      return await response.text();
    },
    catch: (cause) => ({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

/**
 * The provider snapshot has no version when its boot probe timed out; the
 * review then asks the CLI itself rather than reporting "unknown".
 */
export const installedVersionWithFallback = (
  snapshot: Effect.Effect<string | null>,
  cli: Effect.Effect<string | null>,
): Effect.Effect<string | null> =>
  snapshot.pipe(Effect.flatMap((version) => (version === null ? cli : Effect.succeed(version))));

const CLI_VERSION_TIMEOUT_MS = 30_000;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const serverSettings = yield* ServerSettingsService;
  const cliContext = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>();
  const paths = DEFAULT_REVIEW_PATHS;
  const updatesHome = (
    process.env.PB_UPDATES_HOME ??
    path.join(NodeOS.homedir(), ".personal-bots", "claude-code-updates")
  ).replaceAll("\\", "/");
  return yield* makeWith({
    enabled: claudeCodeReviewEnabled(process.env),
    paths,
    excerptDir: path.join(config.stateDir, "claude-code-updates").replaceAll("\\", "/"),
    updatesHome,
    pinnedSdk: normalizeVersion(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"]),
    fetchText,
    installedClaudeCode: installedVersionWithFallback(
      providers.getProviders.pipe(
        Effect.map(
          (list) => list.find((provider) => provider.driver === "claudeAgent")?.version ?? null,
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
      serverSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          runClaudeCommand(settings.providers.claudeAgent, ["--version"]),
        ),
        Effect.timeoutOption(CLI_VERSION_TIMEOUT_MS),
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (result) =>
              result.code === 0
                ? parseGenericCliVersion(`${result.stdout}\n${result.stderr}`)
                : null,
          }),
        ),
        Effect.provide(cliContext),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    ),
    getMeta: (key) => repository.getMeta({ key }),
    setMeta: (key, value) => repository.setMeta({ key, value }),
    getBot: () =>
      repository.listBots().pipe(
        Effect.map((list) =>
          Option.fromNullishOr(
            list.find((bot) => bot.botId === updatesBotCreateInput(paths).botId),
          ),
        ),
        Effect.map(Option.map((bot) => ({ instructions: bot.instructions }))),
      ),
    createBot: () => bots.create(updatesBotCreateInput(paths)).pipe(Effect.asVoid),
    updateBotInstructions: (instructions, description) =>
      bots
        .update({
          botId: updatesBotCreateInput(paths).botId,
          instructions,
          description,
          title: updatesBotCreateInput(paths).title,
        })
        .pipe(Effect.asVoid),
    getRoutine: (routineId) =>
      routines.get({ routineId }).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<PersonalRoutine>()),
      ),
    createRoutine: (input) => routines.create(input).pipe(Effect.asVoid),
    removeRoutine: (routineId) => routines.remove({ routineId }),
    registerPreparer: routines.registerPreparer,
    readFile: (file) =>
      fs.readFileString(file).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    writeFile: (file, text) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text))),
  });
});

export const layer = Layer.effect(PersonalClaudeCodeReview, make);
