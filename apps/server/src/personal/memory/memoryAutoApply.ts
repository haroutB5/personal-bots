/**
 * Memory without manual approval (1.60.42).
 *
 * A rule the owner states in their own chat, and every memory tidy-up (rescope,
 * merge, retire, forget, a proposals file), is made at once, with an Undo in the
 * chat line or the Memory screen's log, instead of waiting on a card. What stays
 * closed is unchanged: a rule whose words are not the owner's own (web pages,
 * emails, other bots, delegated tasks, routines) is refused, and a chat that had
 * a site the user marked sensitive open saves nothing.
 *
 * `T3CODE_PERSONAL_MEMORY_AUTO_APPLY=off` brings the cards back: bots propose,
 * the tidy-up lists its changes under "Waiting for your OK", and the nightly
 * run starts as a preview again.
 */
export const MEMORY_AUTO_APPLY_ENV = "T3CODE_PERSONAL_MEMORY_AUTO_APPLY";

export const memoryAutoApplyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[MEMORY_AUTO_APPLY_ENV]?.trim().toLowerCase() !== "off";
