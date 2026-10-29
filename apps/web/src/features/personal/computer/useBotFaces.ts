import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";

import type { BotAvatarShape, EnvironmentId } from "@t3tools/contracts";

import { primaryServerProvidersAtom } from "~/state/server";

import { botActiveModelShortLabel } from "../botModelLabel";
import { usePersonalBotsList } from "../usePersonalBots";

/** How the Computer tab draws a bot: its real avatar, name and model line. */
export interface BotFace {
  readonly name: string;
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly model: string | null;
}

export interface BotRef {
  readonly botId?: string | null;
  readonly botName?: string | null;
}

export const FALLBACK_FACE_COLOR = "#8c8c88";

/**
 * Looks a bot up by id, then by name (browser activity only carries the name).
 * Unknown bots still get a face (a plain blob in grey) so a row never loses its
 * avatar slot.
 */
export function useBotFaces(environmentId: EnvironmentId | null): (ref: BotRef) => BotFace | null {
  const list = usePersonalBotsList(environmentId);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const bots = list.data?.bots;
  const faces = useMemo(() => {
    const byId = new Map<string, BotFace>();
    const byName = new Map<string, BotFace>();
    for (const bot of bots ?? []) {
      const face: BotFace = {
        name: bot.name,
        shape: bot.avatarShape,
        color: bot.avatarColor,
        model: botActiveModelShortLabel(bot, providers),
      };
      byId.set(bot.botId, face);
      byName.set(bot.name, face);
    }
    return { byId, byName };
  }, [bots, providers]);
  return useCallback(
    (ref: BotRef) => {
      const found =
        (ref.botId ? faces.byId.get(ref.botId) : undefined) ??
        (ref.botName ? faces.byName.get(ref.botName) : undefined);
      if (found !== undefined) return found;
      if (!ref.botName) return null;
      return { name: ref.botName, shape: "blob", color: FALLBACK_FACE_COLOR, model: null };
    },
    [faces],
  );
}
