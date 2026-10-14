/**
 * DeepSeekBalanceWatcher - tells the owner before a DeepSeek account runs dry.
 *
 * A prepaid balance is the one provider problem the app can see coming, and it
 * cannot be discovered from a page: the server has to look. This service does
 * that look, cheaply, and only ever sends one notice per low spell.
 *
 * - **After a finished turn.** A `turn.completed` for a DeepSeek instance asks
 *   for a reading, debounced to at most one per instance per five minutes: a
 *   chatty session must not become a balance poll per turn.
 * - **A light timer.** Every thirty minutes it sweeps the instances that are
 *   enabled *and* have a key. With nothing to watch it makes no request at all,
 *   so a disabled or keyless DeepSeek costs nothing.
 * - **One notice per spell.** At or below $1.00 the owner is told once (a
 *   different, stronger notice when the account is actually empty). The warned
 *   flag lives in `personal_meta`, so a server restart does not warn again, and
 *   it is cleared only once the balance is back above $1.50 - a top-up.
 *
 * The reading itself is the DeepSeek provider's existing one
 * (`deepSeekBalanceReader`, cached for ten minutes), so the key still only ever
 * travels in the request's Authorization header and the same single reader
 * serves the card. A failed read is silent and changes nothing (see
 * `decideDeepSeekBalanceAlert`).
 *
 * @module personal/deepseek/DeepSeekBalanceWatcher
 */
import type { ProviderInstanceId, ProviderRuntimeEvent, ServerProvider } from "@t3tools/contracts";
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
import {
  deepSeekBalanceReader,
  type DeepSeekBalanceRead,
} from "../../provider/Drivers/DeepSeekBalance.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV } from "../../provider/Drivers/DeepSeekEnvironment.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import {
  DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS,
  DEEPSEEK_BALANCE_CHECK_INTERVAL_MS,
  decideDeepSeekBalanceAlert,
  deepSeekBalanceAlertMetaKey,
  deepSeekBalanceWarnedValue,
  parseDeepSeekBalanceWarned,
} from "./deepSeekBalanceAlert.ts";

/** Any tagged service error; the watcher logs and moves on rather than branching on them. */
interface DepFailure {
  readonly _tag: string;
}

/**
 * The instances worth spending a request on: DeepSeek, enabled, and carrying a
 * key. `auth.status` is the probe's own reading of the instance environment, so
 * a keyless instance is never asked.
 */
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
  readonly runtimeEvents: Stream.Stream<ProviderRuntimeEvent>;
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
  /** Parks until server activation, then watches turns and the timer. */
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
  // In memory only: the debounce is about not asking twice within a few
  // minutes, and a restart may as well ask once. The warned flag, which must
  // survive a restart, is in `personal_meta` instead.
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
      const warned = parseDeepSeekBalanceWarned(Option.getOrUndefined(persisted));
      const decision = decideDeepSeekBalanceAlert({ read: read.value, warned });
      if (decision.action === "none") return;

      const at = DateTime.formatIso(DateTime.makeUnsafe(now()));
      if (decision.action === "clear") {
        yield* deps
          .setMeta(key, deepSeekBalanceWarnedValue({ warned: false, at }))
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
          deepSeekBalanceWarnedValue({ warned: true, at, balance: decision.alert.balance }),
        )
        .pipe(Effect.ignore);
    });

  const check: DeepSeekBalanceWatcherShape["check"] = (input) =>
    Effect.gen(function* () {
      const at = now();
      const key = String(input.instanceId);
      if (input.force !== true) {
        const last = lastCheckMs.get(key);
        if (last !== undefined && at - last < DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS) return;
      }
      // Recorded before the read, so two turns finishing together ask once.
      lastCheckMs.set(key, at);
      const providers = yield* deps.getProviders.pipe(Effect.orElseSucceed(() => []));
      const provider = watchableDeepSeekProviders(providers).find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (provider === undefined) return;
      yield* evaluate(provider.instanceId, provider);
    });

  const sweep: DeepSeekBalanceWatcherShape["sweep"] = Effect.gen(function* () {
    const providers = yield* deps.getProviders.pipe(Effect.orElseSucceed(() => []));
    for (const provider of watchableDeepSeekProviders(providers)) {
      yield* check({ instanceId: provider.instanceId, force: true });
    }
  });

  const handleRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (event.type !== "turn.completed") return;
      const instanceId = event.providerInstanceId;
      if (instanceId === undefined) return;
      yield* check({ instanceId });
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
    });

  return Effect.succeed({ start, check, sweep });
};

export class DeepSeekBalanceWatcher extends Context.Service<
  DeepSeekBalanceWatcher,
  DeepSeekBalanceWatcherShape
>()("t3/personal/deepseek/DeepSeekBalanceWatcher") {}

/** The instance's key from the server-side settings, whose secrets are materialized. */
function instanceToken(environment: ReadonlyArray<{ name: string; value: string }> | undefined) {
  const token = environment
    ?.find((variable) => variable.name === DEEPSEEK_AUTH_TOKEN_ENV)
    ?.value.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry;
  const providerService = yield* ProviderService;
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
    getProviders: providers.getProviders,
    runtimeEvents: providerService.streamEvents,
    readBalance,
    getMeta: (key) => bots.getMeta({ key }),
    setMeta: (key, value) => bots.setMeta({ key, value }),
    notify: push.notifyDeepSeekBalanceLow,
  });
});

export const layer = Layer.effect(DeepSeekBalanceWatcher, make);
