/**
 * DeepSeekBalanceWatcher - tells the owner before a DeepSeek account runs dry.
 *
 * A prepaid balance is the one provider problem the app can see coming, and it
 * cannot be discovered from a page: the server has to look.
 *
 * - After a finished turn. A `TurnSettled` for a DeepSeek session asks for a
 *   reading, debounced to at most one per instance per five minutes.
 * - A light timer. Every thirty minutes it sweeps the instances that are
 *   enabled and have a key. With nothing to watch it makes no request.
 * - The moment a key shows up. The registry's change stream is watched for an
 *   instance reaching authenticated, and the check it missed runs then.
 * - One notice per spell. At or below $1.00 the owner is told once, and the
 *   spell may escalate once to the stronger empty notice. The announced kind
 *   lives in `personal_meta`, so a restart does not warn again, and it is
 *   cleared only once the balance is back above $1.50.
 *
 * The reading is the provider's shared one (`deepSeekBalanceReader`, cached for
 * ten minutes), so the key still only travels in the request's Authorization
 * header and the same reader serves the card. A failed read is silent and
 * changes nothing.
 *
 * @module personal/deepseek/DeepSeekBalanceWatcher
 */
import type { ProviderInstanceId, ServerProvider, ThreadId } from "@t3tools/contracts";
import {
  DEEPSEEK_AUTH_TOKEN_ENV,
  deepSeekBalanceReader,
  type DeepSeekBalanceRead,
} from "@t3tools/provider-deepseek/server";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { withStallJob } from "../../observability/stallJobs.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { PersonalProviders, type PersonalSessionEvent } from "../engine/PersonalProviders.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import {
  DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS,
  DEEPSEEK_BALANCE_CHECK_INTERVAL_MS,
  decideDeepSeekBalanceAlert,
  deepSeekBalanceAlertMetaKey,
  deepSeekBalanceLastKindValue,
  parseDeepSeekBalanceLastKind,
} from "./deepSeekBalanceAlert.ts";

/** Any tagged service error; a meta failure is ignored rather than branched on. */
interface DepFailure {
  readonly _tag: string;
}

/** The instances worth spending a request on: DeepSeek, enabled, and carrying a key. */
export function watchableDeepSeekProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.driver === "deepseek" &&
      provider.enabled &&
      provider.auth.status === "authenticated",
  );
}

export interface DeepSeekBalanceWatcherDeps {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly runtimeEvents: Stream.Stream<PersonalSessionEvent>;
  /** Every provider snapshot the registry publishes, newest state each time. */
  readonly providerChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  /** The instance's key, then one reading with it; none when it has no key. */
  readonly readBalance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<DeepSeekBalanceRead>>;
  readonly getMeta: (key: string) => Effect.Effect<Option.Option<string>, DepFailure>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, DepFailure>;
  readonly notify: (input: {
    readonly instanceId: string;
    readonly label: string;
    readonly balance: string;
    readonly empty: boolean;
    readonly at: string;
  }) => Effect.Effect<void>;
  /** Tests: the clock the debounce runs on. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface DeepSeekBalanceWatcherShape {
  /** Parks until server activation, then watches turns, provider changes and the timer. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** One reading for one instance; `force` skips the debounce (the timer's path). */
  readonly check: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly force?: boolean;
  }) => Effect.Effect<void>;
  /** One pass over every watchable instance; the timer's body. */
  readonly sweep: Effect.Effect<void>;
}

export const makeWith = (
  deps: DeepSeekBalanceWatcherDeps,
): Effect.Effect<DeepSeekBalanceWatcherShape> => {
  const now = deps.now ?? Date.now;
  // In memory only: a restart may as well ask once. The announced kind, which
  // must survive a restart, is in `personal_meta` instead.
  const lastCheckMs = new Map<string, number>();

  const evaluate = (
    instanceId: ProviderInstanceId,
    provider: ServerProvider,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const read = yield* deps
        .readBalance(instanceId)
        .pipe(Effect.orElseSucceed(() => Option.none<DeepSeekBalanceRead>()));
      if (Option.isNone(read)) return;

      const key = deepSeekBalanceAlertMetaKey(instanceId);
      const persisted = yield* deps
        .getMeta(key)
        .pipe(Effect.orElseSucceed(() => Option.none<string>()));
      const lastKind = parseDeepSeekBalanceLastKind(Option.getOrUndefined(persisted));
      const decision = decideDeepSeekBalanceAlert({ read: read.value, lastKind });
      if (decision.action === "none") return;

      const at = DateTime.formatIso(DateTime.makeUnsafe(now()));
      if (decision.action === "clear") {
        yield* deps
          .setMeta(key, deepSeekBalanceLastKindValue({ kind: null, at }))
          .pipe(Effect.ignore);
        return;
      }

      const label = provider.displayName ?? "DeepSeek";
      // Notify first, then remember: a crash in between costs one repeated
      // notice, where the other order would silently drop the warning.
      yield* deps
        .notify({
          instanceId,
          label,
          balance: decision.alert.balance,
          empty: decision.alert.kind === "empty",
          at,
        })
        .pipe(Effect.ignore);
      yield* deps
        .setMeta(
          key,
          deepSeekBalanceLastKindValue({
            kind: decision.alert.kind,
            at,
            balance: decision.alert.balance,
          }),
        )
        .pipe(Effect.ignore);
    });

  /** The debounced read for a provider already known to be watchable. */
  const checkProvider = (provider: ServerProvider, force: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const at = now();
      const key = String(provider.instanceId);
      if (!force) {
        const last = lastCheckMs.get(key);
        if (last !== undefined && at - last < DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS) return;
      }
      // Recorded before the read, so two turns finishing together ask once.
      lastCheckMs.set(key, at);
      yield* evaluate(provider.instanceId, provider);
    });

  const check: DeepSeekBalanceWatcherShape["check"] = (input) =>
    Effect.gen(function* () {
      const providers = yield* deps.getProviders.pipe(Effect.orElseSucceed(() => []));
      const provider = watchableDeepSeekProviders(providers).find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (provider === undefined) return;
      yield* checkProvider(provider, input.force === true);
    });

  const sweep: DeepSeekBalanceWatcherShape["sweep"] = Effect.gen(function* () {
    const providers = yield* deps.getProviders.pipe(Effect.orElseSucceed(() => []));
    for (const provider of watchableDeepSeekProviders(providers)) {
      yield* check({ instanceId: provider.instanceId, force: true });
    }
  });

  // A turn event names its chat, not its instance; `SessionStarted` is where
  // that mapping arrives.
  const sessionInstances = new Map<ThreadId, ProviderInstanceId>();

  const handleRuntimeEvent = (event: PersonalSessionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "SessionStarted":
          if (event.instanceId !== null) sessionInstances.set(event.threadId, event.instanceId);
          return;
        case "SessionExited":
          sessionInstances.delete(event.threadId);
          return;
        case "TurnSettled": {
          const instanceId = sessionInstances.get(event.threadId);
          if (instanceId === undefined) return;
          yield* check({ instanceId });
          return;
        }
      }
    });

  /**
   * The instances already seen watchable since boot. A DeepSeek probe reads the
   * balance itself, so it can call an instance authenticated well after the
   * startup sweep went past; that arrival is when the missed check is taken.
   */
  const watchableSinceBoot = new Set<string>();

  const handleProviderChange = (providers: ReadonlyArray<ServerProvider>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const watchable = watchableDeepSeekProviders(providers);
      const current = new Set(watchable.map((provider) => String(provider.instanceId)));
      for (const provider of watchable) {
        const key = String(provider.instanceId);
        if (watchableSinceBoot.has(key)) continue;
        watchableSinceBoot.add(key);
        yield* checkProvider(provider, false);
      }
      // A key taken away and saved again is a new arrival, not a stale one.
      for (const key of watchableSinceBoot) {
        if (!current.has(key)) watchableSinceBoot.delete(key);
      }
    });

  const start: DeepSeekBalanceWatcherShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("deepseek balance sweep failed", { cause: Cause.pretty(cause) }),
          ),
          withStallJob("job:deepseek-balance-watch"),
          Effect.repeat(Schedule.spaced(Duration.millis(DEEPSEEK_BALANCE_CHECK_INTERVAL_MS))),
        ),
      );
      yield* forkParked(Stream.runForEach(deps.runtimeEvents, handleRuntimeEvent));
      yield* forkParked(Stream.runForEach(deps.providerChanges, handleProviderChange));
    });

  return Effect.succeed({ start, check, sweep });
};

export class DeepSeekBalanceWatcher extends Context.Service<
  DeepSeekBalanceWatcher,
  DeepSeekBalanceWatcherShape
>()("t3/personal/deepseek/DeepSeekBalanceWatcher") {}

/** The instance's key from the server-side settings, whose secrets are materialized. */
function instanceToken(
  environment: ReadonlyArray<{ readonly name: string; readonly value: unknown }> | undefined,
) {
  const value = environment?.find((variable) => variable.name === DEEPSEEK_AUTH_TOKEN_ENV)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const make = Effect.gen(function* () {
  const providers = yield* PersonalProviders;
  const serverSettings = yield* ServerSettingsService;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const push = yield* PersonalPushService.PersonalPushService;

  const readBalance = (
    instanceId: ProviderInstanceId,
  ): Effect.Effect<Option.Option<DeepSeekBalanceRead>> =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const token = instanceToken(settings.providerInstances[instanceId]?.environment);
      if (token === undefined) return Option.none<DeepSeekBalanceRead>();
      return Option.some(yield* Effect.promise(() => deepSeekBalanceReader.read(token)));
    }).pipe(Effect.orElseSucceed(() => Option.none<DeepSeekBalanceRead>()));

  return yield* makeWith({
    getProviders: providers.listProviders().pipe(Effect.orElseSucceed(() => [])),
    runtimeEvents: providers.sessionEvents,
    providerChanges: providers.streamChanges,
    readBalance,
    getMeta: (key) => bots.getMeta({ key }),
    setMeta: (key, value) => bots.setMeta({ key, value }),
    notify: push.notifyDeepSeekBalanceLow,
  });
});

export const layer = Layer.effect(DeepSeekBalanceWatcher, make);
