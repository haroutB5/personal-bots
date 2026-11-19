import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { emailOAuthLayers, scriptedOAuth } from "../../testing/emailOAuthFixture.ts";
import {
  checkGoogleClient,
  checkMicrosoftClient,
  googleExchangeCode,
  microsoftDevicePoll,
  microsoftDeviceStart,
  refreshAccessToken,
} from "./oauth.ts";
import type { OAuthClientConfig } from "./oauthClients.ts";

const GOOGLE: Extract<OAuthClientConfig, { vendorId: "gmail" }> = {
  vendorId: "gmail",
  clientId: "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
  clientSecret: Redacted.make("GOCSPX-super-secret-value-1234"),
};
const MICROSOFT: Extract<OAuthClientConfig, { vendorId: "outlook" }> = {
  vendorId: "outlook",
  clientId: "11111111-2222-3333-4444-555555555555",
};

const provide = <A, E>(
  script: ReturnType<typeof scriptedOAuth>,
  effect: Effect.Effect<A, E, any>,
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(script.layer, emailOAuthLayers(new Map()))),
  ) as Effect.Effect<A, E, never>;

describe("google code exchange", () => {
  it.effect("posts the code and the web client's secret and keeps the refresh token", () => {
    const script = scriptedOAuth([
      { status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3599 } },
    ]);
    return Effect.gen(function* () {
      const grant = yield* googleExchangeCode(GOOGLE, Redacted.make("4/0one-time"));
      expect(Redacted.value(grant.refreshToken)).toBe("RT");
      expect(script.posts).toHaveLength(1);
      expect(script.posts[0]).toMatchObject({
        url: "https://oauth2.googleapis.com/token",
        form: {
          grant_type: "authorization_code",
          code: "4/0one-time",
          client_id: GOOGLE.clientId,
          redirect_uri: "",
        },
      });
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("refuses a sign-in that came back without a refresh token", () => {
    const script = scriptedOAuth([{ status: 200, body: { access_token: "AT", expires_in: 3599 } }]);
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(googleExchangeCode(GOOGLE, Redacted.make("c")));
      expect(failure.detail).toMatch(/no lasting access/);
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("reports a bad code without echoing the code or the secret", () => {
    const script = scriptedOAuth([
      {
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "Bad code 4/0one-time with GOCSPX-super-secret-value-1234",
        },
      },
    ]);
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(googleExchangeCode(GOOGLE, Redacted.make("4/0one-time")));
      expect(failure.detail).not.toContain("4/0one-time");
      expect(failure.detail).not.toContain("GOCSPX-super-secret-value-1234");
    }).pipe((effect) => provide(script, effect));
  });
});

describe("refresh", () => {
  it.effect("invalid_grant means the owner has to sign in again", () => {
    const script = scriptedOAuth([{ status: 400, body: { error: "invalid_grant" } }]);
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(refreshAccessToken(GOOGLE, Redacted.make("RT")));
      expect(failure.unauthorized).toBe(true);
    }).pipe((effect) => provide(script, effect));
  });

  it.effect(
    "a Microsoft refresh sends the scopes and a transient failure is not unauthorized",
    () => {
      const script = scriptedOAuth([{ status: 503, body: "busy" }]);
      return Effect.gen(function* () {
        const failure = yield* Effect.flip(refreshAccessToken(MICROSOFT, Redacted.make("RT")));
        expect(failure.unauthorized).toBeUndefined();
        expect(script.posts[0]?.url).toBe(
          "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        );
        expect(script.posts[0]?.form["scope"]).toContain("Mail.Send");
      }).pipe((effect) => provide(script, effect));
    },
  );
});

describe("microsoft device code", () => {
  it.effect("starts a code and maps every poll answer to one outcome", () => {
    const script = scriptedOAuth([
      {
        status: 200,
        body: {
          device_code: "DC",
          user_code: "ABCD1234",
          verification_uri: "https://www.microsoft.com/link",
          expires_in: 900,
          interval: 5,
        },
      },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "expired_token" } },
      { status: 400, body: { error: "authorization_declined" } },
      { status: 400, body: { error: "invalid_client", error_description: "AADSTS7000218 DC" } },
      { status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } },
    ]);
    return Effect.gen(function* () {
      const start = yield* microsoftDeviceStart(MICROSOFT);
      expect(start.userCode).toBe("ABCD1234");
      const tags = [];
      for (let poll = 0; poll < 6; poll += 1) {
        tags.push(yield* microsoftDevicePoll(MICROSOFT, start.deviceCode));
      }
      expect(tags.map((outcome) => outcome._tag)).toEqual([
        "pending",
        "pending",
        "expired",
        "declined",
        "failed",
        "granted",
      ]);
      expect(tags[1]).toEqual({ _tag: "pending", slowDown: true });
      const failed = tags[4];
      if (failed?._tag !== "failed") throw new Error("expected failed");
      expect(failed.error.detail).not.toContain("DC");
      expect(script.posts[1]?.form["grant_type"]).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
    }).pipe((effect) => provide(script, effect));
  });
});

describe("setup checks", () => {
  it.effect("a real Google client answers a made-up code with invalid_grant and passes", () => {
    const script = scriptedOAuth([{ status: 400, body: { error: "invalid_grant" } }]);
    return Effect.gen(function* () {
      expect(yield* checkGoogleClient(GOOGLE)).toEqual({ ok: true });
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("a wrong Google secret is told apart and named", () => {
    const script = scriptedOAuth([{ status: 401, body: { error: "invalid_client" } }]);
    return Effect.gen(function* () {
      const check = yield* checkGoogleClient(GOOGLE);
      expect(check).toMatchObject({ ok: false });
      expect(check.ok ? "" : check.problem).toMatch(/client ID and secret/);
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("an unreachable provider is a retry message, not a verdict on the id", () => {
    const script = scriptedOAuth(["unreachable", "unreachable"]);
    return Effect.gen(function* () {
      for (const check of [
        yield* checkGoogleClient(GOOGLE),
        yield* checkMicrosoftClient(MICROSOFT),
      ]) {
        expect(check.ok ? "" : check.problem).toMatch(/could not reach/);
      }
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("an application id that is not for personal accounts says so", () => {
    const script = scriptedOAuth([
      {
        status: 400,
        body: {
          error: "unauthorized_client",
          error_description: "AADSTS700016: Application not found",
        },
      },
    ]);
    return Effect.gen(function* () {
      const check = yield* checkMicrosoftClient(MICROSOFT);
      expect(check.ok ? "" : check.problem).toMatch(/Personal Microsoft accounts only/);
    }).pipe((effect) => provide(script, effect));
  });

  it.effect("a Microsoft application id that starts a device code passes", () => {
    const script = scriptedOAuth([
      {
        status: 200,
        body: {
          device_code: "DC",
          user_code: "X",
          verification_uri: "https://www.microsoft.com/link",
        },
      },
    ]);
    return Effect.gen(function* () {
      expect(yield* checkMicrosoftClient(MICROSOFT)).toEqual({ ok: true });
    }).pipe((effect) => provide(script, effect));
  });
});
