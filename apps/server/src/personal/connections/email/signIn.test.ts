import { ConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import {
  emailOAuthLayers,
  scriptedOAuth,
  type ScriptedReply,
} from "../../testing/emailOAuthFixture.ts";
import * as Repository from "../repository.ts";
import * as Service from "../service.ts";
import type { VendorHttp } from "../vendors/vendorHttp.ts";
import { layer as pendingLayer } from "./pendingDevices.ts";
import * as SignIn from "./signIn.ts";

const GOOGLE_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const GOOGLE_SECRET = "GOCSPX-super-secret-value-1234";
const MICROSOFT_ID = "11111111-2222-3333-4444-555555555555";
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

interface Recorded {
  readonly vendorId: string;
  readonly address: string;
  readonly displayName: string;
  readonly refreshToken: string;
}

const harness = (replies: Array<ScriptedReply>, profile: unknown) => {
  const script = scriptedOAuth(replies);
  const connected: Array<Recorded> = [];
  const profileCalls: Array<string> = [];
  const vendorHttp: VendorHttp = (request) =>
    Effect.sync(() => {
      profileCalls.push(
        `${request.url} ${request.bearer === undefined ? "" : Redacted.value(request.bearer)}`,
      );
      return { status: 200, body: profile, headers: {} };
    });
  const connections = Layer.mock(Service.PersonalConnectionService)({
    connectMailbox: (input) =>
      Effect.sync(() => {
        connected.push({
          vendorId: input.vendorId,
          address: input.address,
          displayName: input.displayName,
          refreshToken: Redacted.value(input.refreshToken),
        });
        return Repository.presentConnection({
          connectionId: ConnectionId.make("conn-1"),
          vendorId: input.vendorId,
          status: "connected",
          account: {
            accountId: input.address,
            accountName: input.displayName,
            teamId: null,
            teamName: null,
          },
          verifiedCapabilities: [],
          settings: {} as never,
          credentialRef: "ref",
          credentialVersion: 1,
          lastValidatedAt: DateTime.makeUnsafe("2026-11-19T10:00:00.000Z"),
          createdAt: DateTime.makeUnsafe("2026-11-19T10:00:00.000Z"),
          updatedAt: DateTime.makeUnsafe("2026-11-19T10:00:00.000Z"),
        });
      }),
  });
  const base = emailOAuthLayers(new Map());
  const layer = SignIn.layerWith(vendorHttp).pipe(
    Layer.provideMerge(Layer.mergeAll(base, script.layer, pendingLayer, connections)),
  );
  return { script, connected, profileCalls, layer };
};

const saveGoogle = SignIn.EmailSignIn.use((signIn) =>
  signIn.saveClient({
    vendorId: "gmail",
    clientId: GOOGLE_ID,
    clientSecret: Redacted.make(GOOGLE_SECRET),
  }),
);

describe("EmailSignIn.saveClient", () => {
  it.effect("refuses a value of the wrong shape without calling the provider", () => {
    const { script, layer } = harness([], {});
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      const result = yield* signIn.saveClient({
        vendorId: "outlook",
        clientId: "not-a-guid",
      });
      expect(result.saved).toBe(false);
      expect(result.problem).toMatch(/Application \(client\) ID/);
      expect(script.posts).toHaveLength(0);
      expect(yield* signIn.clients()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("saves Google's client when the dummy code is answered invalid_grant", () => {
    const { script, layer } = harness(
      [{ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }],
      {},
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      expect(yield* saveGoogle).toEqual({ vendorId: "gmail", saved: true, problem: null });
      expect(script.posts[0]?.form["code"]).not.toBe("");
      expect(yield* signIn.clients()).toEqual([{ vendorId: "gmail", clientId: GOOGLE_ID }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not save a Google client the provider calls invalid_client", () => {
    const { layer } = harness(
      [{ status: 401, body: { error: "invalid_client", error_description: "Unauthorized" } }],
      {},
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      const result = yield* saveGoogle;
      expect(result.saved).toBe(false);
      expect(result.problem).toMatch(/does not accept this client ID and secret/);
      expect(yield* signIn.clients()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never returns the client secret in a result", () => {
    const { layer } = harness([{ status: 400, body: { error: "invalid_grant" } }], {});
    return Effect.gen(function* () {
      const result = yield* saveGoogle;
      expect(JSON.stringify(result)).not.toContain(GOOGLE_SECRET);
    }).pipe(Effect.provide(layer));
  });
});

describe("EmailSignIn.gmailExchangeCode", () => {
  it.effect("is refused until the one-time setup is done", () => {
    const { script, layer } = harness([], {});
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      const failure = yield* Effect.flip(
        signIn.gmailExchangeCode({ serverAuthCode: Redacted.make("4/0code") }),
      );
      expect(failure.message).toMatch(/Gmail is not set up yet/);
      expect(script.posts).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("swaps the code, asks Google whose mailbox it is, and stores the refresh token", () => {
    const { connected, profileCalls, layer } = harness(
      [
        { status: 400, body: { error: "invalid_grant" } },
        {
          status: 200,
          body: {
            access_token: "ya29.access",
            refresh_token: "1//0refresh",
            expires_in: 3599,
            scope: GMAIL_SCOPES,
          },
        },
      ],
      { emailAddress: "Harout@Gmail.com" },
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveGoogle;
      const result = yield* signIn.gmailExchangeCode({ serverAuthCode: Redacted.make("4/0code") });
      expect(result.connection.account?.accountId).toBe("harout@gmail.com");
      expect(connected).toEqual([
        {
          vendorId: "gmail",
          address: "harout@gmail.com",
          displayName: "harout@gmail.com",
          refreshToken: "1//0refresh",
        },
      ]);
      expect(profileCalls).toEqual([
        "https://gmail.googleapis.com/gmail/v1/users/me/profile ya29.access",
      ]);
      expect(JSON.stringify(result)).not.toMatch(/1\/\/0refresh|ya29/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a sign-in where the owner left a permission unticked", () => {
    const { connected, layer } = harness(
      [
        { status: 400, body: { error: "invalid_grant" } },
        {
          status: 200,
          body: {
            access_token: "ya29.access",
            refresh_token: "1//0refresh",
            expires_in: 3599,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          },
        },
      ],
      { emailAddress: "a@gmail.com" },
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveGoogle;
      const failure = yield* Effect.flip(
        signIn.gmailExchangeCode({ serverAuthCode: Redacted.make("4/0code") }),
      );
      expect(failure.message).toMatch(/Tick both boxes/);
      expect(connected).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

const deviceStart: ScriptedReply = {
  status: 200,
  body: {
    device_code: "DEVICE-SECRET",
    user_code: "ABCD1234",
    verification_uri: "https://www.microsoft.com/link",
    expires_in: 900,
    interval: 5,
  },
};
const pending: ScriptedReply = { status: 400, body: { error: "authorization_pending" } };
const outlookGrant: ScriptedReply = {
  status: 200,
  body: {
    access_token: "EwB-access",
    refresh_token: "M.C-refresh",
    expires_in: 3600,
    scope: "Mail.ReadWrite Mail.Send User.Read",
  },
};

const saveOutlook = SignIn.EmailSignIn.use((signIn) =>
  signIn.saveClient({ vendorId: "outlook", clientId: MICROSOFT_ID }),
);

describe("EmailSignIn Outlook device sign-in", () => {
  it.effect("shows a code, waits while the owner signs in, then connects once", () => {
    const { connected, layer } = harness(
      [deviceStart, deviceStart, pending, outlookGrant, { status: 400, body: {} }],
      { mail: "Harout@Outlook.com", displayName: "Harout" },
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveOutlook;
      const started = yield* signIn.outlookDeviceStart();
      expect(started.userCode).toBe("ABCD1234");
      expect(started.verificationUri).toBe("https://www.microsoft.com/link");
      expect(JSON.stringify(started)).not.toContain("DEVICE-SECRET");

      expect(yield* signIn.outlookDevicePoll({ signInId: started.signInId })).toEqual({
        _tag: "pending",
        intervalSec: 5,
      });
      const done = yield* signIn.outlookDevicePoll({ signInId: started.signInId });
      expect(done._tag).toBe("connected");
      expect(connected).toEqual([
        {
          vendorId: "outlook",
          address: "harout@outlook.com",
          displayName: "Harout",
          refreshToken: "M.C-refresh",
        },
      ]);

      const again = yield* signIn.outlookDevicePoll({ signInId: started.signInId });
      expect(again._tag).toBe("failed");
      expect(connected).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports expiry once the code's lifetime has passed, without calling Microsoft", () => {
    const { script, layer } = harness([deviceStart, deviceStart], {});
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveOutlook;
      const started = yield* signIn.outlookDeviceStart();
      const postsBefore = script.posts.length;
      yield* TestClock.adjust("901 seconds");
      expect(yield* signIn.outlookDevicePoll({ signInId: started.signInId })).toEqual({
        _tag: "expired",
      });
      expect(script.posts).toHaveLength(postsBefore);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a declined sign-in and forgets it", () => {
    const { layer } = harness(
      [deviceStart, deviceStart, { status: 400, body: { error: "authorization_declined" } }],
      {},
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveOutlook;
      const started = yield* signIn.outlookDeviceStart();
      expect(yield* signIn.outlookDevicePoll({ signInId: started.signInId })).toEqual({
        _tag: "declined",
      });
      const after = yield* signIn.outlookDevicePoll({ signInId: started.signInId });
      expect(after._tag).toBe("failed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an id the server never issued", () => {
    const { script, layer } = harness([deviceStart], {});
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveOutlook;
      const outcome = yield* signIn.outlookDevicePoll({ signInId: "made-up-by-someone" });
      expect(outcome._tag).toBe("failed");
      expect(script.posts).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("slow_down lengthens the interval the phone is told to wait", () => {
    const { layer } = harness(
      [deviceStart, deviceStart, { status: 400, body: { error: "slow_down" } }],
      {},
    );
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      yield* saveOutlook;
      const started = yield* signIn.outlookDeviceStart();
      expect(yield* signIn.outlookDevicePoll({ signInId: started.signInId })).toEqual({
        _tag: "pending",
        intervalSec: 10,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("is refused until the application id has been saved", () => {
    const { layer } = harness([], {});
    return Effect.gen(function* () {
      const signIn = yield* SignIn.EmailSignIn;
      const failure = yield* Effect.flip(signIn.outlookDeviceStart());
      expect(failure.message).toMatch(/Outlook is not set up yet/);
    }).pipe(Effect.provide(layer));
  });
});
