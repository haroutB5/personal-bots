import type { PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * One painted row. Display data only, so a token or a message body has no
 * field it could enter.
 */
export const BotRow = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  lead: Schema.Boolean,
  title: Schema.String,
  model: Schema.String,
  chats: Schema.Finite,
});
export type BotRow = typeof BotRow.Type;

export const CachedBots = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  savedAtMs: Schema.Finite,
  serverVersion: Schema.NullOr(Schema.String),
  rows: Schema.Array(BotRow),
});
export type CachedBots = typeof CachedBots.Type;

export const MAX_CACHED_ROWS = 60;
const MAX_NAME_CHARS = 80;
const MAX_LABEL_CHARS = 80;

const decodeCachedBots = Schema.decodeUnknownSync(CachedBots);

export interface BotsCacheStorage {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

function firstLine(value: string, maxChars: number): string {
  return value.split("\n", 1)[0]?.trim().slice(0, maxChars) ?? "";
}

export function botRows(
  bots: ReadonlyArray<PersonalBot>,
  threads: ReadonlyArray<PersonalBotThread>,
): ReadonlyArray<BotRow> {
  return bots.slice(0, MAX_CACHED_ROWS).map((bot) => ({
    botId: bot.botId,
    name: firstLine(bot.name, MAX_NAME_CHARS),
    lead: bot.lead === true,
    title: firstLine(bot.title, MAX_LABEL_CHARS),
    model: `${String(bot.modelSelection.instanceId)}/${bot.modelSelection.model}`,
    chats: threads.filter((thread) => thread.botId === bot.botId && thread.archivedAt === null)
      .length,
  }));
}

export function buildBotsCache(input: {
  readonly environmentId: string;
  readonly serverVersion: string | null;
  readonly savedAtMs: number;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly threads: ReadonlyArray<PersonalBotThread>;
}): CachedBots {
  return {
    version: 1,
    environmentId: input.environmentId,
    savedAtMs: input.savedAtMs,
    serverVersion: input.serverVersion,
    rows: botRows(input.bots, input.threads),
  };
}

export function decodeBotsCache(raw: string, environmentId: string): CachedBots | null {
  try {
    const cache = decodeCachedBots(JSON.parse(raw) as unknown);
    return cache.environmentId === environmentId ? cache : null;
  } catch {
    return null;
  }
}

export async function readBotsCache(
  storage: BotsCacheStorage,
  environmentId: string,
): Promise<CachedBots | null> {
  let raw: string | null;
  try {
    raw = await storage.read();
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const cache = decodeBotsCache(raw, environmentId);
  if (cache === null) {
    await clearBotsCache(storage);
  }
  return cache;
}

export async function writeBotsCache(storage: BotsCacheStorage, cache: CachedBots): Promise<void> {
  try {
    await storage.write(JSON.stringify(cache));
  } catch {
    return;
  }
}

export async function clearBotsCache(storage: BotsCacheStorage): Promise<void> {
  try {
    await storage.remove();
  } catch {
    return;
  }
}
