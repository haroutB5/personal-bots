import { egressPause } from "./computerContract";
import { readMockScenario } from "./computerData";
import { useComputerFeed } from "./computerState";
import { usePersonalEnvironmentId } from "../usePersonalBots";

/** The mock scenarios (?computerMock=) where a bot is waiting on the owner. */
const MOCK_ASKING: ReadonlySet<string> = new Set([
  "help",
  "helpCode",
  "helpLogin",
  "sensitive",
  "controlBrowser",
]);

/**
 * True while a bot is waiting on the owner at the shared browser: a CAPTCHA,
 * code or sign-in, or a sensitive-site pause. The tab bar dots the Computer
 * tab for it.
 */
export function useComputerAsk(): boolean {
  const { feed } = useComputerFeed(usePersonalEnvironmentId());
  if (MOCK_ASKING.has(readMockScenario() ?? "")) return true;
  return feed.status?.helpRequest != null || egressPause(feed.status) !== null;
}
