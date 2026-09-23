import * as Schema from "effect/Schema";

import type { BotAvatarColor, BotAvatarShape } from "@t3tools/contracts";
import {
  BotAvatarColor as BotAvatarColorSchema,
  BotAvatarShape as BotAvatarShapeSchema,
} from "@t3tools/contracts";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

/**
 * Cold-start snapshot for the Chats list. After each successful
 * `personalBots.list` the screen persists just enough to paint instantly on
 * the next launch: identity, avatar, the bot's static title and a one-line preview.
 * Live state (working dots, rate limits, review row) is deliberately absent —
 * it needs live data and stays neutral until the list arrives.
 *
 * Never message bodies, never secrets. This is structural, not a convention:
 * {@link ChatsSnapshotRowInput} has no field a message body can enter. The
 * stored preview is a server-authored turn label when there is one, else the
 * thread title — both already server-side metadata. The rendered row shows the
 * newest message line, but that line lives only in memory, because the
 * snapshot is at rest in `localStorage` with no credential in front of it.
 */
export const ChatsSnapshotRow = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  avatarShape: BotAvatarShapeSchema,
  avatarColor: BotAvatarColorSchema,
  subtitle: Schema.String,
  /**
   * One-line preview, already trimmed to {@link MAX_SNAPSHOT_PREVIEW_CHARS}.
   * Derived from a turn label or the thread title — never message text.
   */
  preview: Schema.String,
  previewAtMs: Schema.NullOr(Schema.Finite),
  threadId: Schema.NullOr(Schema.String),
  threadTitle: Schema.NullOr(Schema.String),
  /**
   * Whether the bot sits in the Pinned box. Structural metadata, not content:
   * without it the cold paint had no pinned box at all and the section only
   * appeared once `personalBots.list` landed.
   */
  pinned: Schema.Boolean,
});
export type ChatsSnapshotRow = typeof ChatsSnapshotRow.Type;

export const ChatsSnapshot = Schema.Struct({
  version: Schema.Literal(3),
  environmentId: Schema.String,
  savedAtMs: Schema.Finite,
  rows: Schema.Array(ChatsSnapshotRow),
});
export type ChatsSnapshot = typeof ChatsSnapshot.Type;

const ChatsSnapshotEnvelope = Schema.Struct({
  environmentId: Schema.String,
  snapshot: ChatsSnapshot,
});

const STORAGE_KEY = "t3code:chats-snapshot:v3";
/**
 * Keys written by earlier shapes of this snapshot. A v2 entry has no `pinned`
 * flag, so painting it would reproduce the bug v3 fixes (pinned box missing on
 * the very first paint) and then reshuffle the rows when the live list landed.
 * Reading drops them instead of migrating: one cold start falls back to the
 * skeleton, and nothing stale is left sitting in `localStorage`.
 */
const LEGACY_STORAGE_KEYS = ["t3code:chats-snapshot:v2"] as const;
/** Phone-first lists are short; beyond this the snapshot stops paying for itself. */
export const MAX_SNAPSHOT_ROWS = 30;
export const MAX_SNAPSHOT_PREVIEW_CHARS = 140;
const MAX_SNAPSHOT_NAME_CHARS = 80;
const MAX_SNAPSHOT_LABEL_CHARS = 80;
const MAX_SNAPSHOT_TITLE_CHARS = 120;
/** Hard byte budget for the stored snapshot; least-recent rows drop first. */
export const MAX_SNAPSHOT_BYTES = 64_000;

export interface ChatsSnapshotRowInput {
  readonly botId: string;
  readonly name: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: BotAvatarColor;
  /** Static bot title only; a snapshot cannot know live status. */
  readonly subtitle: string;
  /**
   * A server-authored turn label ("Delegated to Developer", …) and nothing
   * else. There is deliberately no field for the newest message's text: null
   * falls back to the thread title, which is what a plain chat stores.
   */
  readonly previewLabel: string | null;
  readonly previewAtMs: number | null;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  /** Mirrors `isBotPinned(bot)` at the time the list was fetched. */
  readonly pinned: boolean;
}

function firstLine(value: string, maxChars: number): string {
  return value.split("\n", 1)[0]?.trim().slice(0, maxChars) ?? "";
}

function snapshotBytes(environmentId: string, snapshot: ChatsSnapshot): number {
  const json = JSON.stringify({ environmentId, snapshot });
  return new TextEncoder().encode(json).length;
}

/**
 * Pure builder: sanitizes inputs (single-line, capped), keeps the incoming
 * order, and drops trailing rows until the byte budget holds. Rows arrive in
 * render order — the pinned box first, then the list ordered by latest
 * activity — so the tail is both the cheapest and the safest to lose.
 */
export function buildChatsSnapshot(input: {
  readonly environmentId: string;
  readonly savedAtMs: number;
  readonly rows: ReadonlyArray<ChatsSnapshotRowInput>;
}): ChatsSnapshot {
  const sanitized = input.rows.slice(0, MAX_SNAPSHOT_ROWS).map((row): ChatsSnapshotRow => ({
    botId: row.botId,
    name: firstLine(row.name, MAX_SNAPSHOT_NAME_CHARS),
    avatarShape: row.avatarShape,
    avatarColor: row.avatarColor,
    subtitle: firstLine(row.subtitle, MAX_SNAPSHOT_LABEL_CHARS),
    preview: firstLine(row.previewLabel ?? row.threadTitle ?? "", MAX_SNAPSHOT_PREVIEW_CHARS),
    previewAtMs: row.previewAtMs,
    threadId: row.threadId,
    threadTitle:
      row.threadTitle === null ? null : firstLine(row.threadTitle, MAX_SNAPSHOT_TITLE_CHARS),
    pinned: row.pinned,
  }));
  const rows = [...sanitized];
  const probe: ChatsSnapshot = {
    version: 3 as const,
    environmentId: input.environmentId,
    savedAtMs: input.savedAtMs,
    rows,
  };
  while (rows.length > 1 && snapshotBytes(input.environmentId, probe) > MAX_SNAPSHOT_BYTES) {
    rows.pop();
  }
  return probe;
}

/**
 * Splits stored rows the way {@link partitionPinnedSummaries} splits the live
 * list. The builder already received them in render order, so preserving that
 * order here is what keeps the cold paint from reshuffling when the live list
 * replaces it.
 */
export function partitionPinnedSnapshotRows(rows: ReadonlyArray<ChatsSnapshotRow>): {
  readonly pinned: ReadonlyArray<ChatsSnapshotRow>;
  readonly rest: ReadonlyArray<ChatsSnapshotRow>;
} {
  return {
    pinned: rows.filter((row) => row.pinned),
    rest: rows.filter((row) => !row.pinned),
  };
}

function removeQuietly(): void {
  try {
    removeLocalStorageItem(STORAGE_KEY);
  } catch {
    // Best effort: a stale or corrupt entry must never break the render path.
  }
}

function removeLegacyQuietly(): void {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      removeLocalStorageItem(key);
    } catch {
      // Best effort: a leftover entry must never break the render path.
    }
  }
}

/**
 * Reads the snapshot for an environment, dropping any entry written by an
 * older shape on the way through. Returns null when there is none,
 * when it belongs to another environment (clearing the stale entry), or when
 * storage fails or holds corrupt data. Never throws.
 */
export function readChatsSnapshot(environmentId: string | null): ChatsSnapshot | null {
  if (environmentId === null) return null;
  removeLegacyQuietly();
  let envelope: typeof ChatsSnapshotEnvelope.Type | null;
  try {
    envelope = getLocalStorageItem(STORAGE_KEY, ChatsSnapshotEnvelope);
  } catch {
    removeQuietly();
    return null;
  }
  if (envelope === null) return null;
  if (envelope.environmentId !== environmentId) {
    removeQuietly();
    return null;
  }
  return envelope.snapshot;
}

/**
 * The saved snapshot before the environment is known. The app boots with no
 * environment id for a few hundred milliseconds (it arrives with the
 * connection), and waiting for it left the skeleton on screen while a good
 * snapshot sat in storage. The entry is read as-is here and never deleted: the
 * environment check happens as soon as the id is known (readChatsSnapshot),
 * which replaces a foreign snapshot with the skeleton. Never throws.
 */
export function readChatsSnapshotBeforeEnvironment(): ChatsSnapshot | null {
  try {
    return getLocalStorageItem(STORAGE_KEY, ChatsSnapshotEnvelope)?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * Persists a snapshot. Quota or encode failures drop the cache instead of
 * surfacing: the list simply paints from skeletons next launch. Never throws.
 */
export function writeChatsSnapshot(environmentId: string, snapshot: ChatsSnapshot): void {
  try {
    setLocalStorageItem(STORAGE_KEY, { environmentId, snapshot }, ChatsSnapshotEnvelope);
  } catch {
    removeQuietly();
  }
}

/**
 * Removes every row matching `predicate`, and drops the entry entirely once
 * nothing is left. Deletion happens from screens the Chats list is not mounted
 * behind, so the only writer (`ChatsScreen`'s persist effect) may not run for
 * a long time — until it does, a cold start would keep painting the deleted
 * chat as a live deep link. Returns the rows that survived, or null when the
 * snapshot is gone. Never throws.
 */
export function dropChatFromSnapshot(
  environmentId: string | null,
  predicate: (row: ChatsSnapshotRow) => boolean,
): ChatsSnapshot | null {
  if (environmentId === null) return null;
  const snapshot = readChatsSnapshot(environmentId);
  if (snapshot === null) return null;
  const rows = snapshot.rows.filter((row) => !predicate(row));
  if (rows.length === snapshot.rows.length) return snapshot;
  if (rows.length === 0) {
    removeQuietly();
    return null;
  }
  const next: ChatsSnapshot = { ...snapshot, rows };
  writeChatsSnapshot(environmentId, next);
  return next;
}
