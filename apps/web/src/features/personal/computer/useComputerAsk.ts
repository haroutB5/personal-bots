import { egressPause } from "./computerContract";
import { useComputerFeed } from "./computerState";
import { usePersonalEnvironmentId } from "../usePersonalBots";

/**
 * True while a bot is waiting on the owner at the shared browser: a CAPTCHA,
 * code or sign-in, or a sensitive-site pause. The tab bar dots the Computer
 * tab for it.
 */
export function useComputerAsk(): boolean {
  const { feed } = useComputerFeed(usePersonalEnvironmentId());
  return feed.status?.helpRequest != null || egressPause(feed.status) !== null;
}
