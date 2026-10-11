/**
 * The optional `followUp` on `thread.turn.start` (the 1.66.28 steer/queue
 * send): "steer", the default when the field is absent, folds the message into
 * the bot's running turn; "queue" asks the server to hold it and start it as a
 * new turn after the running one ends. With an idle bot the two behave the
 * same.
 *
 * LOCAL TYPE: Backend adds the field to the real contract on
 * `fix/hbots-steer-queue`. Until that branch is merged, this module is the one
 * place the web side names the type; after the merge, drop it and use the
 * contract's own export (same field name and shape).
 */
export type TurnFollowUp = "steer" | "queue";
