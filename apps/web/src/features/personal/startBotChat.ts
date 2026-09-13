import { useCallback, useState } from "react";

import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { personalBotCreateThread } from "./usePersonalBots";

/**
 * Starts a new chat with a bot and opens it. The thread id is generated on the
 * client, so a retried create is idempotent server-side. `replace` swaps the
 * current history entry (used when leaving a chat for its replacement).
 */
export function useStartBotChat(environmentId: EnvironmentId | null, botId: PersonalBotId | null) {
  const navigate = useNavigate();
  const createThread = useAtomCommand(personalBotCreateThread);
  const [starting, setStarting] = useState(false);

  const start = useCallback(
    async (options?: { readonly replace?: boolean }) => {
      if (environmentId === null || botId === null || starting) return;
      setStarting(true);
      const threadId = ThreadId.make(randomUUID());
      const result = await createThread({ environmentId, input: { botId, threadId } });
      setStarting(false);
      if (result._tag === "Success") {
        await navigate({
          to: "/bots/$botId/$threadId",
          params: { botId, threadId },
          replace: options?.replace ?? false,
        });
      }
    },
    [botId, createThread, environmentId, navigate, starting],
  );

  return { start, starting };
}
