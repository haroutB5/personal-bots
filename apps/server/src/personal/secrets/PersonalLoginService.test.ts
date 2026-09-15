import { PersonalLoginId, PersonalLoginsError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalLoginRepository from "./PersonalLoginRepository.ts";
import * as PersonalLoginService from "./PersonalLoginService.ts";

const THREAD = ThreadId.make("thread-owner");
const PASSWORD = "top-secret-password";
const now = DateTime.makeUnsafe("2026-09-14T00:00:00.000Z");

const login: PersonalLoginRepository.StoredPersonalLogin = {
  loginId: PersonalLoginId.make("login-example"),
  label: "Example",
  origin: "https://example.com",
  username: "person@example.com",
  secretRef: "opaque-secret-ref",
  sensitive: false,
  createdAt: now,
  updatedAt: now,
};

const makeLayer = (
  browserCalls: Array<Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]>,
  repository: Partial<PersonalLoginRepository.PersonalLoginRepository["Service"]> = {},
  store: Partial<ServerSecretStore.ServerSecretStore["Service"]> = {},
) =>
  PersonalLoginService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PersonalLoginRepository.PersonalLoginRepository,
        PersonalLoginRepository.PersonalLoginRepository.of({
          list: () => Effect.succeed([login]),
          get: () => Effect.succeed(Option.some(login)),
          create: () => Effect.void,
          update: () => Effect.succeed(true),
          remove: () => Effect.succeed(true),
          setSensitive: (input) =>
            Effect.succeed(Option.some({ ...login, sensitive: input.sensitive })),
          sensitiveOrigins: () => Effect.succeed([]),
          ...repository,
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode(PASSWORD))),
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
          ...store,
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(PersonalBrowser.PersonalBrowser)({
        fillLogin: (input) =>
          Effect.sync(() => {
            browserCalls.push(input);
            return ["username", "password"] as const;
          }),
      }),
    ),
  );

// A saved origin is compared to the page with plain string equality, so only
// the one canonical spelling of an origin may be stored.
describe("normalizePersonalLoginOrigin", () => {
  const accepted = [
    "https://example.com",
    "https://example.com:8443",
    "https://sub.example.com",
    "https://xn--exmple-4nf.com",
  ];
  for (const origin of accepted) {
    it(`accepts ${origin}`, () => {
      expect(PersonalLoginService.normalizePersonalLoginOrigin(origin)).toBe(origin);
    });
  }

  const refused = [
    ["plain http", "http://example.com"],
    ["a trailing-dot host", "https://example.com."],
    ["a trailing-dot host with a port", "https://example.com.:8443"],
    ["an uppercase host", "https://EXAMPLE.com"],
    ["a trailing slash", "https://example.com/"],
    ["a path", "https://example.com/login"],
    ["an explicit default port", "https://example.com:443"],
    ["user info", "https://person@example.com"],
    // Stored only as the punycode the browser would report, never as Unicode.
    ["an IDN look-alike in Unicode", "https://exаmple.com"],
  ] as const;
  for (const [name, origin] of refused) {
    it(`refuses ${name}`, () => {
      expect(PersonalLoginService.normalizePersonalLoginOrigin(origin)).toBeNull();
    });
  }
});

// Marking a site sensitive is a toggle on the list, so unlike an edit it must
// not demand the password again, and it never touches the secret store.
describe("PersonalLoginService setSensitive", () => {
  it.effect("marks and unmarks a login without reading or writing any password", () => {
    const touched: string[] = [];
    const record = (operation: string) =>
      Effect.sync(() => {
        touched.push(operation);
      });
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const marked = yield* service.setSensitive({ loginId: login.loginId, sensitive: true });
      expect(marked).toMatchObject({ loginId: login.loginId, sensitive: true });
      expect(marked).not.toHaveProperty("secretRef");
      const cleared = yield* service.setSensitive({ loginId: login.loginId, sensitive: false });
      expect(cleared.sensitive).toBe(false);
      expect(touched).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer(
          [],
          {},
          {
            get: () => Effect.as(record("get"), Option.none()),
            set: () => record("set"),
            create: () => record("create"),
            remove: () => record("remove"),
          },
        ),
      ),
    );
  });

  it.effect("reports a login that no longer exists", () =>
    Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const error = yield* service
        .setSensitive({ loginId: login.loginId, sensitive: true })
        .pipe(Effect.flip);
      expect(error.message).toContain("Saved login was not found.");
    }).pipe(Effect.provide(makeLayer([], { setSensitive: () => Effect.succeedNone }))),
  );

  it.effect("lists the flag with every login", () =>
    Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const result = yield* service.list();
      expect(result.logins.map((entry) => entry.sensitive)).toEqual([true]);
    }).pipe(
      Effect.provide(
        makeLayer([], { list: () => Effect.succeed([{ ...login, sensitive: true }]) }),
      ),
    ),
  );
});

describe("PersonalLoginService use", () => {
  it.effect("keeps the old password and origin when a metadata update fails", () => {
    const oldKey = PersonalLoginService.personalLoginStoreKey(login.secretRef);
    const values = new Map([[oldKey, PASSWORD]]);
    const write = (key: string, bytes: Uint8Array) =>
      Effect.sync(() => {
        values.set(key, new TextDecoder().decode(bytes));
      });
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      yield* service
        .update({
          ...login,
          origin: "https://other.example",
          password: Redacted.make("replacement-password"),
        })
        .pipe(Effect.flip);
      expect([...values]).toEqual([[oldKey, PASSWORD]]);
    }).pipe(
      Effect.provide(
        makeLayer(
          [],
          {
            update: () => Effect.fail(new PersistenceSqlError({ operation: "update" })),
          },
          {
            create: write,
            set: write,
            remove: (key) =>
              Effect.sync(() => {
                values.delete(key);
              }),
          },
        ),
      ),
    );
  });

  it.effect(
    "publishes the replacement password with its new metadata before retiring the old secret",
    () => {
      const oldKey = PersonalLoginService.personalLoginStoreKey(login.secretRef);
      const values = new Map([[oldKey, PASSWORD]]);
      let updated: PersonalLoginRepository.StoredPersonalLogin | undefined;
      return Effect.gen(function* () {
        const service = yield* PersonalLoginService.PersonalLoginService;
        const result = yield* service.update({
          ...login,
          origin: "https://other.example",
          password: Redacted.make("replacement-password"),
        });
        expect(result.origin).toBe("https://other.example");
        expect(updated?.secretRef).not.toBe(login.secretRef);
        expect([...values.values()]).toEqual(["replacement-password"]);
        expect(values.has(oldKey)).toBe(false);
      }).pipe(
        Effect.provide(
          makeLayer(
            [],
            {
              update: (next) =>
                Effect.sync(() => {
                  expect(values.get(oldKey)).toBe(PASSWORD);
                  expect(
                    values.get(PersonalLoginService.personalLoginStoreKey(next.secretRef)),
                  ).toBe("replacement-password");
                  updated = next;
                  return true;
                }),
            },
            {
              create: (key, bytes) =>
                Effect.sync(() => {
                  values.set(key, new TextDecoder().decode(bytes));
                }),
              set: (key, bytes) =>
                Effect.sync(() => {
                  values.set(key, new TextDecoder().decode(bytes));
                }),
              remove: (key) =>
                Effect.sync(() => {
                  values.delete(key);
                }),
            },
          ),
        ),
      );
    },
  );

  // Saved logins are shared by every bot (user decision, 2026-09-14): what is
  // refused is a name that matches nothing, not a caller.
  it.effect("refuses an unknown login before reading or filling any secret", () => {
    const browserCalls: Array<
      Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]
    > = [];
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const error = yield* service
        .use({ threadId: THREAD, labelOrOrigin: "Nothing saved" })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PersonalLoginsError);
      expect(error.message).toContain("No saved login with that label or origin exists.");
      expect(browserCalls).toEqual([]);
    }).pipe(Effect.provide(makeLayer(browserCalls)));
  });

  it.effect("lets any bot's thread use a saved login", () => {
    const browserCalls: Array<
      Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]
    > = [];
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      yield* service.use({ threadId: ThreadId.make("thread-other"), labelOrOrigin: "Example" });
      yield* service.use({ threadId: THREAD, labelOrOrigin: "https://example.com" });
      expect(browserCalls.map((call) => call.threadId)).toEqual(["thread-other", THREAD]);
    }).pipe(Effect.provide(makeLayer(browserCalls)));
  });

  it.effect("passes the stored values only to the browser and returns field names", () => {
    const browserCalls: Array<
      Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]
    > = [];
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const result = yield* service.use({ threadId: THREAD, labelOrOrigin: "Example" });
      expect(browserCalls).toEqual([
        {
          threadId: THREAD,
          label: "Example",
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: PASSWORD,
        },
      ]);
      expect(result).toEqual({ success: true, filled: ["username", "password"] });
      expect(result).not.toHaveProperty("password");
      expect(result).not.toHaveProperty("username");
    }).pipe(Effect.provide(makeLayer(browserCalls)));
  });
});
