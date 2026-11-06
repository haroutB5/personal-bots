import type { PersonalSecretRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * What this device did with a request it showed. The server has no activity
 * stream for secrets — `personalSecrets.listPending` only ever returns rows
 * that are still pending — so a settled card reads its ending from the RPC this
 * screen itself ran. A request that left `pending` without this device
 * answering it (another phone, the bot already had the value) is "closed".
 */
export type SecretRequestOutcome = "provided" | "declined";

/**
 * A settled card this device kept from an earlier visit. The record carries
 * only what the settled card draws, so a value can never be stored with it.
 */
export interface SecretRequestHistoryEntry {
  readonly requestId: string;
  readonly threadId: string;
  readonly createdAtMs: number;
  readonly name: string;
  readonly label: string;
  readonly outcome: SecretRequestOutcome;
}

/**
 * A secret the bot asked for, in the state the transcript should show it.
 *
 * No variant carries a value, and none ever can: the only value that exists on
 * the client is the string inside the open card's own input, which is never
 * lifted out of the component that holds it.
 */
export type SecretRequestCardItem =
  | {
      readonly kind: "pending";
      readonly requestId: string;
      readonly createdAtMs: number;
      readonly request: PersonalSecretRequest;
    }
  | {
      readonly kind: "provided" | "declined" | "closed";
      readonly requestId: string;
      readonly createdAtMs: number;
      readonly name: string;
      readonly label: string;
    };

const createdAtMs = (request: PersonalSecretRequest): number =>
  DateTime.toEpochMillis(request.createdAt);

/**
 * The cards to render for one chat, oldest first.
 *
 * `seen` is every request this screen has shown so far. Answering removes the
 * row from `listPending`, and without that memory the card would vanish
 * mid-tap, leaving no sign that the bot ever asked or that the user answered.
 */
export function deriveSecretRequestCards(
  pending: ReadonlyArray<PersonalSecretRequest>,
  threadId: string,
  seen: ReadonlyMap<string, PersonalSecretRequest>,
  outcomes: ReadonlyMap<string, SecretRequestOutcome>,
  history: ReadonlyArray<SecretRequestHistoryEntry> = [],
): ReadonlyArray<SecretRequestCardItem> {
  const forThread = pending.filter((request) => request.threadId === threadId);
  const pendingById = new Map(forThread.map((request) => [request.requestId as string, request]));
  const requests = new Map<string, PersonalSecretRequest>();
  for (const [requestId, request] of seen) {
    if (request.threadId === threadId) requests.set(requestId, request);
  }
  for (const [requestId, request] of pendingById) {
    if (!requests.has(requestId)) requests.set(requestId, request);
  }

  const cards: SecretRequestCardItem[] = [];
  const claimed = new Set<string>();
  for (const [requestId, request] of requests) {
    const live = pendingById.get(requestId);
    if (live !== undefined) {
      cards.push({
        kind: "pending",
        requestId,
        createdAtMs: createdAtMs(live),
        request: live,
      });
      claimed.add(requestId);
      continue;
    }
    cards.push({
      kind: outcomes.get(requestId) ?? "closed",
      requestId,
      createdAtMs: createdAtMs(request),
      name: request.name,
      label: request.label,
    });
    claimed.add(requestId);
  }
  for (const entry of history) {
    if (entry.threadId !== threadId || claimed.has(entry.requestId)) continue;
    cards.push({
      kind: entry.outcome,
      requestId: entry.requestId,
      createdAtMs: entry.createdAtMs,
      name: entry.name,
      label: entry.label,
    });
  }
  return cards.sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/**
 * The chats a bot is parked on a secret in. The bots list uses it for the row's
 * "Needs a secret" status, so a request is visible without opening the chat.
 */
export function threadIdsAwaitingSecret(
  pending: ReadonlyArray<PersonalSecretRequest>,
): ReadonlySet<string> {
  return new Set(pending.map((request) => request.threadId as string));
}
