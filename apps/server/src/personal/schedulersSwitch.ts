/**
 * Server switch for restored test copies (restore-test.ps1 and the nightly and
 * upstream-sync rehearsals that run it):
 *
 *   T3CODE_PERSONAL_SCHEDULERS=off
 *
 * A restored production copy keeps the real routines, queued tasks and provider
 * CLIs, so without this its routine catch-up queued real routine runs within
 * seconds of boot. With the switch off nothing starts a turn on its own: the
 * routine tick never runs, the task queue and group rounds never start a turn
 * (no sweep, no pump), usage-limit chat resumes stay scheduled and pending
 * release notices stay in the inbox. Read once at boot. The live start path (start.ps1,
 * restart.ps1, the logon task) clears it, and a server with it off logs one
 * WARN line at boot so it is never left on unnoticed.
 */
import * as Effect from "effect/Effect";

export const PERSONAL_SCHEDULERS_ENV = "T3CODE_PERSONAL_SCHEDULERS";

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/** True when the environment turns the personal schedulers off. Unset or any other value: on. */
export const personalSchedulersOff = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => OFF_VALUES.has(env[PERSONAL_SCHEDULERS_ENV]?.trim().toLowerCase() ?? "");

export const PERSONAL_SCHEDULERS_OFF_WARNING =
  "Personal schedulers are OFF (T3CODE_PERSONAL_SCHEDULERS=off): routines, queued tasks, group rounds, usage-limit chat resumes and release notices will not start. Restored test copies only; the live server must never run with this set.";

/** The one boot WARN line; nothing when the schedulers are on. */
export const logPersonalSchedulersAtBoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<void> =>
  personalSchedulersOff(env) ? Effect.logWarning(PERSONAL_SCHEDULERS_OFF_WARNING) : Effect.void;
