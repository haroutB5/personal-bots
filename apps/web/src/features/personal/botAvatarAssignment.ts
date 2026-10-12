import type { BotAvatarShape } from "@t3tools/contracts";

import { BOT_AVATAR_SHAPE_ORDER, BOT_AVATAR_SWATCHES } from "./botAvatarShapes";

/*
 * Which look a *new* bot gets, so a fresh team never looks like one blue blob
 * five times (Astra's F3: every new bot started as the same blue blob). The
 * rules: a shape+colour combination no other bot uses; once every combination
 * is taken, the least-used one. An existing bot's look is never touched, and
 * the owner's own pick always wins over this.
 */

export interface BotLook {
  readonly shape: BotAvatarShape;
  readonly color: string;
}

/** A saved bot's look, as the bot list holds it. */
export interface BotLookSource {
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: string;
}

/** The list helpers read either form: the form's draft pair, or a saved bot. */
type HasLook = BotLook | BotLookSource;

/** One entry per bot, in the helpers' own shape. */
export function botLooks(bots: ReadonlyArray<BotLookSource>): ReadonlyArray<BotLook> {
  return bots.map((bot) => ({ shape: bot.avatarShape, color: bot.avatarColor }));
}

/**
 * Every palette combination, in the order a new bot walks them: 7 shapes and
 * 12 colours are coprime, so stepping both counters together (shape `i % 7`,
 * colour `i % 12`) visits all 84 pairs exactly once, with both changing from
 * one bot to the next.
 */
export const BOT_LOOK_ORDER: ReadonlyArray<BotLook> = Array.from({ length: 84 }, (_, step) => ({
  shape: BOT_AVATAR_SHAPE_ORDER[step % BOT_AVATAR_SHAPE_ORDER.length]!,
  color: BOT_AVATAR_SWATCHES[step % BOT_AVATAR_SWATCHES.length]!,
}));

const fieldsOf = (look: HasLook): BotLook =>
  "shape" in look ? look : { shape: look.avatarShape, color: look.avatarColor };

const key = (look: HasLook): string => {
  const { shape, color } = fieldsOf(look);
  return `${shape}\u0000${color.toLocaleLowerCase()}`;
};

const PALETTE = new Set(BOT_LOOK_ORDER.map(key));

/** How many bots wear each palette look. A look outside the palette counts for nothing. */
function usageCounts(bots: ReadonlyArray<HasLook>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bot of bots) {
    const id = key(bot);
    if (!PALETTE.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function leastUsedBotLook(counts: ReadonlyMap<string, number>): BotLook {
  let best = BOT_LOOK_ORDER[0]!;
  let bestCount = counts.get(key(best)) ?? 0;
  for (const look of BOT_LOOK_ORDER) {
    const count = counts.get(key(look)) ?? 0;
    if (count < bestCount) {
      best = look;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The look a new bot gets: the first palette combination no bot is wearing.
 * A cold start (no list yet) takes the first one. Deterministic on purpose,
 * so two bots created in a row never race to the same pair.
 */
export function nextFreeBotLook(bots: ReadonlyArray<HasLook>): BotLook {
  const counts = usageCounts(bots);
  return BOT_LOOK_ORDER.find((look) => !counts.has(key(look))) ?? leastUsedBotLook(counts);
}

/**
 * A random look no bot is wearing, for the Shuffle button; any palette look
 * once every combination is taken (the least-used one on average).
 */
export function shuffledBotLook(
  bots: ReadonlyArray<HasLook>,
  random: () => number = Math.random,
): BotLook {
  const counts = usageCounts(bots);
  const free = BOT_LOOK_ORDER.filter((look) => !counts.has(key(look)));
  const pool = free.length > 0 ? free : BOT_LOOK_ORDER;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index] ?? pool[0]!;
}
