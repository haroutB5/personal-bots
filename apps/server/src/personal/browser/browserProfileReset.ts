// @effect-diagnostics nodeBuiltinImport:off - shares the Chrome profile-lock probe in PersonalBrowser.ts and moves the profile with a plain rename.
/**
 * The one way to give the bots' shared browser a clean slate.
 *
 * A profile that used a saved login before 1.60.16 does not know which sites
 * hold its sessions, so page scripts stay disabled on every site. Clearing
 * cookies would not be enough (localStorage, IndexedDB and service workers
 * can carry authentication too), so the reset replaces the whole profile with
 * an empty one and only then clears the protections that guarded the old one.
 *
 * It never runs on its own. `scripts/personal/reset-browser-profile.ps1`
 * writes the request file once the owner has agreed; the server applies it at
 * its next start, before any tool call can reach the browser. The old profile
 * is moved aside, not deleted. Saved logins live in the database and are not
 * touched.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  BrowserProtectionRepositoryError,
  BrowserProtectionState,
} from "./PersonalBrowserProtectionRepository.ts";

export const PROFILE_RESET_REQUEST_FILE = "browser-profile-reset.request";
export const PROFILE_RESET_RESULT_FILE = "browser-profile-reset.result.json";

export type ProfileResetOutcome =
  | { readonly status: "not-requested" }
  | { readonly status: "done"; readonly backupDir: string | null }
  | { readonly status: "failed"; readonly reason: string };

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

const stamp = (now: DateTime.Utc) =>
  DateTime.formatIso(now).replace(/[-:]/g, "").replace(/\..*$/, "");

const encodeResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      at: Schema.String,
      backupDir: Schema.optional(Schema.NullOr(Schema.String)),
      reason: Schema.optional(Schema.String),
    }),
  ),
);

/**
 * Applies a pending reset request. On any failure the old profile and its
 * protections stay exactly as they were and the request is kept, so the next
 * start tries again; the result file says why.
 */
export const applyRequestedProfileReset = (input: {
  /** `<baseDir>/personal`: holds the request and result files. */
  readonly personalDir: string;
  readonly profileDir: string;
  readonly profileId: string;
  readonly now: DateTime.Utc;
  readonly isProfileLocked: (profileDir: string) => Promise<boolean>;
  readonly saveProtections: (
    state: BrowserProtectionState,
  ) => Effect.Effect<void, BrowserProtectionRepositoryError>;
}): Effect.Effect<ProfileResetOutcome> =>
  Effect.gen(function* () {
    const requestPath = NodePath.join(input.personalDir, PROFILE_RESET_REQUEST_FILE);
    if (!(yield* Effect.promise(() => exists(requestPath)))) {
      return { status: "not-requested" } as const;
    }
    const writeResult = (outcome: ProfileResetOutcome) =>
      Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(input.personalDir, PROFILE_RESET_RESULT_FILE),
          `${encodeResult({ ...outcome, at: DateTime.formatIso(input.now) })}\n`,
        ).catch(() => undefined),
      );
    const fail = (reason: string) =>
      Effect.gen(function* () {
        const outcome = { status: "failed", reason } as const;
        yield* writeResult(outcome);
        yield* Effect.logError("Browser profile reset was requested but not applied.", { reason });
        return outcome;
      });

    let backupDir: string | null = null;
    if (yield* Effect.promise(() => exists(input.profileDir))) {
      if (yield* Effect.promise(() => input.isProfileLocked(input.profileDir))) {
        return yield* fail(
          "The browser profile is in use by a Chrome process. Stop that Chrome, then restart the server.",
        );
      }
      const target = `${input.profileDir}.before-reset-${stamp(input.now)}`;
      const moved = yield* Effect.promise(() =>
        NodeFSP.rename(input.profileDir, target).then(
          () => null,
          (cause: unknown) => String((cause as { readonly code?: string }).code ?? cause),
        ),
      );
      if (moved !== null)
        return yield* fail(`The old profile could not be moved aside (${moved}).`);
      backupDir = target;
    }

    // The profile on disk is now empty, so its protections can go. If this
    // write fails the old, stricter protections stay in force over an empty
    // profile, which is safe; the request stays for the next start.
    const saved = yield* input
      .saveProtections({
        profileId: input.profileId,
        loginUsed: false,
        loginOrigins: [],
        taintedOrigins: [],
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!saved) {
      return yield* fail(
        `The browser protections could not be cleared; the old profile is at ${backupDir ?? "(none)"} and page scripts stay disabled.`,
      );
    }
    yield* Effect.promise(() => NodeFSP.rm(requestPath, { force: true }));
    const outcome = { status: "done", backupDir } as const;
    yield* writeResult(outcome);
    yield* Effect.logInfo("Browser profile reset: started with an empty profile.", { backupDir });
    return outcome;
  });
