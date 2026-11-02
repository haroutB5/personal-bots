/**
 * What a personal client needs to know to talk to this server: the hbots
 * release version it runs, and the oldest Android build that may connect.
 *
 * This is a release version ("1.66.110"), not the upstream package version
 * ("0.0.42"). `version.txt` is public and already served to the web client, so
 * the handshake exposes nothing new.
 */
import * as Schema from "effect/Schema";

export const HbotsVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand("HbotsVersion"),
);
export type HbotsVersion = typeof HbotsVersion.Type;

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("Sha256Hex"),
);
export type Sha256Hex = typeof Sha256Hex.Type;

/**
 * The APK the server currently publishes for its own release. `version` is
 * also the route segment the phone downloads from, so a manifest cannot point
 * it at another file.
 */
export const PersonalAndroidRelease = Schema.Struct({
  version: HbotsVersion,
  sha256: Sha256Hex,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1_000_000, maximum: 300_000_000 })),
  notes: Schema.String.check(Schema.isMaxLength(500)),
});
export type PersonalAndroidRelease = typeof PersonalAndroidRelease.Type;

export const PersonalClientCompat = Schema.Struct({
  /** Null when the server has no readable release stamp (a dev root). */
  serverVersion: Schema.NullOr(HbotsVersion),
  android: Schema.Struct({
    minimumNativeVersion: HbotsVersion,
    /** Null when there is no readable, valid published APK manifest. */
    latest: Schema.NullOr(PersonalAndroidRelease),
  }),
});
export type PersonalClientCompat = typeof PersonalClientCompat.Type;

/**
 * The oldest Android APK allowed to run against this server. Bump it only
 * with the server release that requires the new app, because a wrong value
 * locks out every phone: the client shows an update screen and never connects.
 */
export const PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION = HbotsVersion.make("1.66.110");
