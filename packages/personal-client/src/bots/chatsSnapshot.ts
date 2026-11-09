import * as Schema from "effect/Schema";

import type { BotAvatarColor, BotAvatarShape } from "@t3tools/contracts";
import {
  BotAvatarColor as BotAvatarColorSchema,
  BotAvatarShape as BotAvatarShapeSchema,
} from "@t3tools/contracts";

import type { KeyValueStore } from "../ports/keyValueStore.ts";

/**
 * Cold-start snapshot for the Chats list. After each successful
 * `personalBots.list` the screen persists just enough to paint instantly on
 * the next launch: identity, avatar, the bot's static title and a one-line preview.
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

const ChatsSnapshotJson = Schema.fromJsonString(ChatsSnapshotEnvelope);

function removeQuietly(store: KeyValueStore): void {
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Best effort: a stale or corrupt entry must never break the render path.
  }
}

function removeLegacyQuietly(store: KeyValueStore): void {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      store.removeItem(key);
    } catch {
      // Best effort: a leftover entry must never break the render path.
    }
  }
}

const decodeChatsSnapshot = Schema.decodeSync(ChatsSnapshotJson);
const encodeChatsSnapshot = Schema.encodeSync(ChatsSnapshotJson);

function readEnvelope(store: KeyValueStore): typeof ChatsSnapshotEnvelope.Type | null {
  const stored = store.getItem(STORAGE_KEY);
  return stored === null ? null : decodeChatsSnapshot(stored);
}

/**
 * Reads the snapshot for an environment, dropping any entry written by an
 * older shape on the way through. Returns null when there is none,
 * when it belongs to another environment (clearing the stale entry), or when
 * storage fails or holds corrupt data. Never throws.
 */
export function readChatsSnapshot(
  store: KeyValueStore,
  environmentId: string | null,
): ChatsSnapshot | null {
  if (environmentId === null) return null;
  removeLegacyQuietly(store);
  let envelope: typeof ChatsSnapshotEnvelope.Type | null;
  try {
    envelope = readEnvelope(store);
  } catch {
    removeQuietly(store);
    return null;
  }
  if (envelope === null) return null;
  if (envelope.environmentId !== environmentId) {
    removeQuietly(store);
    return null;
  }
  return envelope.snapshot;
}

/**
 * The saved snapshot before the environment is known. The app boots with no
 * environment id for a few hundred milliseconds (it arrives with the
 * connection), and waiting for it left the skeleton on screen while a good
 */
export function readChatsSnapshotBeforeEnvironment(store: KeyValueStore): ChatsSnapshot | null {
  try {
    return readEnvelope(store)?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * Persists a snapshot. Quota or encode failures drop the cache instead of
 * surfacing: the list simply paints from skeletons next launch. Never throws.
 */
export function writeChatsSnapshot(
  store: KeyValueStore,
  environmentId: string,
  snapshot: ChatsSnapshot,
): void {
  try {
    store.setItem(STORAGE_KEY, encodeChatsSnapshot({ environmentId, snapshot }));
  } catch {
    removeQuietly(store);
  }
}

/**
 * Removes every row matching `predicate`, and drops the entry entirely once
 * nothing is left. Deletion happens from screens the Chats list is not mounted
 * behind, so the only writer (`ChatsScreen`'s persist effect) may not run for
 */
export function dropChatFromSnapshot(
  store: KeyValueStore,
  environmentId: string | null,
  predicate: (row: ChatsSnapshotRow) => boolean,
): ChatsSnapshot | null {
  if (environmentId === null) return null;
  const snapshot = readChatsSnapshot(store, environmentId);
  if (snapshot === null) return null;
  const rows = snapshot.rows.filter((row) => !predicate(row));
  if (rows.length === snapshot.rows.length) return snapshot;
  if (rows.length === 0) {
    removeQuietly(store);
    return null;
  }
  const next: ChatsSnapshot = { ...snapshot, rows };
  writeChatsSnapshot(store, environmentId, next);
  return next;
}
