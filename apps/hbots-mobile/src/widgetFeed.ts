import type { WidgetEntry } from "./launcher/nativeLauncher";

/** Native keeps eight and shows five. */
export const MAX_WIDGET_BOTS = 8;

interface WidgetCandidate {
  readonly botId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly pinned?: boolean;
}

/**
 * What the home screen widget gets: `{botId, name, working}` per bot and nothing else. The function
 * copies exactly those three fields into a new object, so a bot record that grows a preview, a
 * message or a thread title can never reach the widget (see `widgetFeed.test.ts`). It lists the
 * enabled pinned bots plus any bot that is working now, working ones first.
 */
export function buildWidgetFeed(
  bots: ReadonlyArray<WidgetCandidate>,
  workingBotIds: ReadonlySet<string>,
): ReadonlyArray<WidgetEntry> {
  const shown = bots.filter(
    (bot) => bot.enabled !== false && (bot.pinned === true || workingBotIds.has(bot.botId)),
  );
  const entries = shown.map((bot): WidgetEntry => ({
    botId: bot.botId,
    name: bot.name,
    working: workingBotIds.has(bot.botId),
  }));
  return entries
    .toSorted((left, right) => Number(right.working) - Number(left.working))
    .slice(0, MAX_WIDGET_BOTS);
}
