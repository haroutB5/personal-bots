import { PersonalBotId, PersonalLoginId, PersonalLoginsError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalLoginRepository from "./PersonalLoginRepository.ts";
import * as PersonalLoginService from "./PersonalLoginService.ts";

const OWNER = PersonalBotId.make("bot-owner");
const OTHER = PersonalBotId.make("bot-other");
const THREAD = ThreadId.make("thread-owner");
const PASSWORD = "top-secret-password";
const now = DateTime.makeUnsafe("2026-09-14T00:00:00.000Z");

const login: PersonalLoginRepository.StoredPersonalLogin = {
  loginId: PersonalLoginId.make("login-example"),
  label: "Example",
  origin: "https://example.com",
  username: "person@example.com",
  secretRef: "opaque-secret-ref",
  botIds: [OWNER],
  createdAt: now,
  updatedAt: now,
};

const makeLayer = (
  browserCalls: Array<Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]>,
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

describe("PersonalLoginService use", () => {
  it.effect("refuses a bot with no grant before reading or filling the secret", () => {
    const browserCalls: Array<
      Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]
    > = [];
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const error = yield* service
        .use({ botId: OTHER, threadId: THREAD, labelOrOrigin: "Example" })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PersonalLoginsError);
      expect(error.message).toContain("granted to this bot");
      expect(browserCalls).toEqual([]);
    }).pipe(Effect.provide(makeLayer(browserCalls)));
  });

  it.effect("passes the stored values only to the browser and returns field names", () => {
    const browserCalls: Array<
      Parameters<PersonalBrowser.PersonalBrowser["Service"]["fillLogin"]>[0]
    > = [];
    return Effect.gen(function* () {
      const service = yield* PersonalLoginService.PersonalLoginService;
      const result = yield* service.use({
        botId: OWNER,
        threadId: THREAD,
        labelOrOrigin: "Example",
      });
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
