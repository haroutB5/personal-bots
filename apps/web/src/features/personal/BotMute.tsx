import type { JSX } from "react";

import type { EnvironmentId, PersonalBot, PersonalBotNotificationMute } from "@t3tools/contracts";
import { BellOff } from "lucide-react";

import { MenuGroup, MenuGroupLabel, MenuItem } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { botMuteState, MUTE_CHOICES, mutedUntilLabel } from "./botMuteModel";
import { personalBotUpdate } from "./usePersonalBots";

/**
 * Mutes or unmutes one bot's notifications. The server stamps the time and the
 * update command refreshes `personalBots.list`, so every bell-slash re-renders
 * from server state rather than a local guess. Resolves true on success.
 */
export function useSetBotMute(
  environmentId: EnvironmentId | null,
): (bot: PersonalBot, mute: PersonalBotNotificationMute) => Promise<boolean> {
  const updateBot = useAtomCommand(personalBotUpdate);
  return async (bot, mute) => {
    if (environmentId === null) return false;
    const result = await updateBot({
      environmentId,
      input: { botId: bot.botId, notificationsMute: mute },
    });
    return result?._tag === "Success";
  };
}

/**
 * The small bell-slash beside a muted bot's name. Secondary ink, not tertiary:
 * it carries meaning, so it has to clear the 3:1 non-text bar in both themes.
 */
export function MutedBell({
  size = 15,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Notifications muted"
      data-muted-bell=""
      className={cn("flex shrink-0 items-center text-[var(--personal-text-secondary)]", className)}
    >
      <BellOff aria-hidden="true" style={{ width: size, height: size }} strokeWidth={2} />
    </span>
  );
}

/**
 * The mute items for a bot's menus (the chat header's "..." and a Chats row's
 * menu): the three lengths while notifications are on, and "Unmute" plus how
 * long it has left while they are off.
 */
export function BotMuteMenuItems({
  bot,
  now,
  onChange,
}: {
  readonly bot: PersonalBot;
  readonly now: number;
  readonly onChange: (mute: PersonalBotNotificationMute) => void;
}): JSX.Element {
  const state = botMuteState(bot, now);
  return (
    <MenuGroup>
      <MenuGroupLabel className="text-[var(--personal-text-secondary)]">
        {state.muted ? mutedUntilLabel(state, now) : "Mute notifications"}
      </MenuGroupLabel>
      {state.muted ? (
        <MenuItem onClick={() => onChange("on")}>Unmute notifications</MenuItem>
      ) : (
        MUTE_CHOICES.map((choice) => (
          <MenuItem key={choice.key} onClick={() => onChange(choice.mute)}>
            {choice.label}
          </MenuItem>
        ))
      )}
    </MenuGroup>
  );
}
