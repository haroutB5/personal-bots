import type { StartChatResult } from "./useStartChat";

/** The connection layer refuses a command before sending it with "<name> is not connected." */
export function isNotConnectedFailure(message: string): boolean {
  return /\bis not connected\.?(?: .*)?$/i.test(message.trim());
}

/** Waits about 15 seconds in total, then gives up: a laptop that is not coming back says so. */
export const CONNECT_WAIT_DELAYS_MS: readonly number[] = [400, 800, 1_500, 2_500, 4_000, 6_000];

export const UNREACHABLE_MESSAGE =
  "Couldn't reach your laptop. Check that it is on and connected, then try again.";

/**
 * Retries `attempt` while the connection is down. Only the failure that happens
 * before anything is sent is retried, always with one thread id, so the chat is created once.
 */
export async function startUntilConnected(
  attempt: () => Promise<StartChatResult>,
  hooks: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly onConnecting: () => void;
    readonly delays?: readonly number[];
    /** True once nobody is waiting for the chat any more (the screen was left). */
    readonly abandoned?: () => boolean;
  },
): Promise<StartChatResult> {
  const delays = hooks.delays ?? CONNECT_WAIT_DELAYS_MS;
  for (let retry = 0; ; retry += 1) {
    const result = await attempt();
    if (result.kind === "started") return result;
    if (!isNotConnectedFailure(result.message)) return result;
    const delay = delays[retry];
    if (hooks.abandoned?.() === true) return result;
    if (delay === undefined) return { kind: "failed", message: UNREACHABLE_MESSAGE };
    hooks.onConnecting();
    await hooks.sleep(delay);
    if (hooks.abandoned?.() === true) return result;
  }
}
