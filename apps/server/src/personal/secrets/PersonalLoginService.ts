import * as NodeCrypto from "node:crypto";

import {
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalLoginsError,
  type PersonalBotId,
  type PersonalLogin,
  type PersonalLoginCreateInput,
  type PersonalLoginDeleteInput,
  type PersonalLoginsListResult,
  type PersonalLoginUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import type { PersonalLoginFilledField } from "../browser/pageOperations.ts";
import * as PersonalLoginRepository from "./PersonalLoginRepository.ts";

export const personalLoginStoreKey = (secretRef: string) => `personal-login-${secretRef}`;

/** Only canonical https origins are persisted, so equality is an exact browser-origin check. */
export const normalizePersonalLoginOrigin = (input: string): string | null => {
  const value = input.trim();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== value
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

export interface UsePersonalLoginResult {
  readonly success: true;
  readonly filled: ReadonlyArray<PersonalLoginFilledField>;
}

export interface UsePersonalLoginInput {
  readonly botId: PersonalBotId;
  readonly threadId: ThreadId;
  readonly labelOrOrigin: string;
}

export class PersonalLoginService extends Context.Service<
  PersonalLoginService,
  {
    readonly list: () => Effect.Effect<PersonalLoginsListResult, PersonalLoginsError>;
    readonly create: (
      input: PersonalLoginCreateInput,
    ) => Effect.Effect<PersonalLogin, PersonalLoginsError>;
    readonly update: (
      input: PersonalLoginUpdateInput,
    ) => Effect.Effect<PersonalLogin, PersonalLoginsError>;
    readonly remove: (input: PersonalLoginDeleteInput) => Effect.Effect<void, PersonalLoginsError>;
    readonly use: (
      input: UsePersonalLoginInput,
    ) => Effect.Effect<UsePersonalLoginResult, PersonalLoginsError>;
  }
>()("t3/personal/secrets/PersonalLoginService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalLoginRepository.PersonalLoginRepository;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const browser = yield* PersonalBrowser.PersonalBrowser;
  // Grant changes and use decisions share one lock, so a UI revocation cannot
  // race between the authorization check and the browser fill.
  const accessLock = yield* Semaphore.make(1);

  const fail = (message: string, cause?: unknown) =>
    new PersonalLoginsError({ message, ...(cause === undefined ? {} : { cause }) });

  const wipe = (bytes: Uint8Array) => Effect.sync(() => bytes.fill(0));

  const db = <A>(
    operation: string,
    effect: Effect.Effect<A, PersonalLoginRepository.PersonalLoginRepositoryError>,
  ) => effect.pipe(Effect.mapError((cause) => fail(`Personal logins ${operation} failed.`, cause)));

  const storedPassword = (password: Redacted.Redacted<string>) => {
    const bytes = new TextEncoder().encode(Redacted.value(password));
    return bytes.byteLength === 0
      ? Effect.fail(fail("Password is required."))
      : bytes.byteLength > PERSONAL_SECRET_MAX_VALUE_BYTES
        ? Effect.fail(
            fail(`Password must be at most ${PERSONAL_SECRET_MAX_VALUE_BYTES} UTF-8 bytes.`),
          )
        : Effect.succeed(bytes);
  };

  const fields = (input: {
    readonly label: string;
    readonly origin: string;
    readonly username: string;
  }) => {
    const label = input.label.trim();
    if (label.length === 0) return Effect.fail(fail("Login label is required."));
    const origin = normalizePersonalLoginOrigin(input.origin);
    if (origin === null) {
      return Effect.fail(fail("Origin must be an exact HTTPS origin such as https://example.com."));
    }
    return Effect.succeed({ label, origin, username: input.username });
  };

  const present = (login: PersonalLoginRepository.StoredPersonalLogin): PersonalLogin => ({
    loginId: login.loginId,
    label: login.label,
    origin: login.origin,
    username: login.username,
    botIds: [...login.botIds],
    createdAt: login.createdAt,
    updatedAt: login.updatedAt,
  });

  const requireLogin = Effect.fn("PersonalLoginService.requireLogin")(function* (
    loginId: PersonalLoginDeleteInput["loginId"],
  ) {
    const login = yield* db("lookup", repository.get(loginId));
    if (Option.isNone(login)) return yield* fail("Saved login was not found.");
    return login.value;
  });

  const list: PersonalLoginService["Service"]["list"] = () =>
    db("list", repository.list()).pipe(Effect.map((logins) => ({ logins: logins.map(present) })));

  const createUnlocked = Effect.fn("PersonalLoginService.create")(function* (
    input: PersonalLoginCreateInput,
  ) {
    const metadata = yield* fields(input);
    const password = yield* storedPassword(input.password);
    const now = yield* DateTime.now;
    const stored: PersonalLoginRepository.StoredPersonalLogin = {
      loginId: input.loginId,
      ...metadata,
      secretRef: NodeCrypto.randomUUID(),
      botIds: [...new Set(input.botIds)],
      createdAt: now,
      updatedAt: now,
    };
    const key = personalLoginStoreKey(stored.secretRef);
    yield* store.create(key, password).pipe(
      Effect.mapError((cause) => fail("Could not store the password.", cause)),
      Effect.ensuring(wipe(password)),
    );
    yield* db("create", repository.create(stored)).pipe(
      Effect.tapError(() => store.remove(key).pipe(Effect.ignore)),
    );
    return present(stored);
  });
  const create: PersonalLoginService["Service"]["create"] = (input) =>
    accessLock.withPermit(createUnlocked(input));

  const updateUnlocked = Effect.fn("PersonalLoginService.update")(function* (
    input: PersonalLoginUpdateInput,
  ) {
    const previous = yield* requireLogin(input.loginId);
    const metadata = yield* fields(input);
    const password = yield* storedPassword(input.password);
    const next: PersonalLoginRepository.StoredPersonalLogin = {
      ...previous,
      ...metadata,
      botIds: [...new Set(input.botIds)],
      updatedAt: yield* DateTime.now,
    };
    yield* store.set(personalLoginStoreKey(previous.secretRef), password).pipe(
      Effect.mapError((cause) => fail("Could not store the password.", cause)),
      Effect.ensuring(wipe(password)),
    );
    const written = yield* db("update", repository.update(next));
    if (!written) return yield* fail("Saved login changed while it was being updated.");
    return present(next);
  });
  const update: PersonalLoginService["Service"]["update"] = (input) =>
    accessLock.withPermit(updateUnlocked(input));

  const removeUnlocked = Effect.fn("PersonalLoginService.remove")(function* (
    input: PersonalLoginDeleteInput,
  ) {
    const previous = yield* requireLogin(input.loginId);
    yield* store
      .remove(personalLoginStoreKey(previous.secretRef))
      .pipe(Effect.mapError((cause) => fail("Could not delete the password.", cause)));
    const removed = yield* db("delete", repository.remove(input.loginId));
    if (!removed) return yield* fail("Saved login changed while it was being deleted.");
  });
  const remove: PersonalLoginService["Service"]["remove"] = (input) =>
    accessLock.withPermit(removeUnlocked(input));

  const useUnlocked = Effect.fn("PersonalLoginService.use")(function* (
    input: UsePersonalLoginInput,
  ) {
    const wanted = input.labelOrOrigin.trim();
    const granted = (yield* db("lookup", repository.list())).filter((login) =>
      login.botIds.includes(input.botId),
    );
    const byLabel = granted.filter(
      (login) => login.label.toLocaleLowerCase() === wanted.toLocaleLowerCase(),
    );
    const matches =
      byLabel.length > 0 ? byLabel : granted.filter((login) => login.origin === wanted);
    if (matches.length === 0) {
      return yield* fail("No saved login with that label or origin is granted to this bot.");
    }
    if (matches.length > 1) {
      return yield* fail("More than one granted login matches that origin; use its label instead.");
    }
    const login = matches[0]!;
    const secret = yield* store
      .get(personalLoginStoreKey(login.secretRef))
      .pipe(Effect.mapError((cause) => fail("Could not read the saved password.", cause)));
    if (Option.isNone(secret)) return yield* fail("The saved password is unavailable.");
    const passwordBytes = secret.value;
    const password = new TextDecoder().decode(passwordBytes);
    const filled = yield* browser
      .fillLogin({
        threadId: input.threadId,
        expectedOrigin: login.origin,
        username: login.username,
        password,
      })
      .pipe(
        Effect.mapError((cause) => fail(cause.message, cause)),
        Effect.ensuring(wipe(passwordBytes)),
      );
    return { success: true as const, filled };
  });
  const use: PersonalLoginService["Service"]["use"] = (input) =>
    accessLock.withPermit(useUnlocked(input));

  return PersonalLoginService.of({ list, create, update, remove, use });
});

export const layer = Layer.effect(PersonalLoginService, make);

export const layerLive = layer.pipe(Layer.provideMerge(PersonalLoginRepository.layer));
