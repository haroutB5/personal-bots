/**
 * What a personal client needs to know to talk to this server: the hbots
 * release version it runs, and the oldest Android build that may connect.
 *
 * This is a release version ("1.66.110"), not the upstream package version
 * ("0.0.42"). `version.txt` is public and already served to the web client, so
 * the handshake exposes nothing new.
 */
import * as Schema from "effect/Schema";

export const HbotsVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+$/),
).pipe(Schema.brand("HbotsVersion"));
export type HbotsVersion = typeof HbotsVersion.Type;

export const PersonalClientCompat = Schema.Struct({
  /** Null when the server has no readable release stamp (a dev root). */
  serverVersion: Schema.NullOr(HbotsVersion),
  android: Schema.Struct({ minimumNativeVersion: HbotsVersion }),
});
export type PersonalClientCompat = typeof PersonalClientCompat.Type;

/**
 * The oldest Android APK allowed to run against this server. Bump it only
 * with the server release that requires the new app, because a wrong value
 * locks out every phone: the client shows an update screen and never connects.
 */
export const PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION = HbotsVersion.make("1.66.110");
