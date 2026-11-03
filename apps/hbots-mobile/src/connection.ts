import type { PersonalBot, PersonalBotThread } from "@t3tools/contracts";

import { classifyFailure, RequestFailure } from "./failure";
import { openSocketUrl } from "./pairing";
import { connectPersonalRpc, type PersonalRpc } from "./rpc";
import type { StoredSession } from "./session";

export const LIST_TIMEOUT_MS = 15_000;
export const REFRESH_INTERVAL_MS = 10_000;
const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export interface BotsSnapshot {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly threads: ReadonlyArray<PersonalBotThread>;
}

export interface OnlineConnection extends BotsSnapshot {
  readonly rpc: PersonalRpc;
}

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(attempt, 0), BACKOFF_MAX_MS);
}

export function withTimeout<A>(work: Promise<A>, ms: number): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestFailure({ kind: "timeout" })), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

export async function refreshBots(rpc: PersonalRpc): Promise<BotsSnapshot> {
  const { result } = await withTimeout(rpc.listBots(), LIST_TIMEOUT_MS);
  return { bots: result.bots, threads: result.threads };
}

export async function openOnline(
  session: StoredSession,
  clientAppVersion: string,
): Promise<OnlineConnection> {
  const socketUrl = await openSocketUrl(session, clientAppVersion);
  const rpc = await connectPersonalRpc(socketUrl);
  try {
    return { rpc, ...(await refreshBots(rpc)) };
  } catch (cause) {
    await rpc.dispose();
    throw cause;
  }
}

export function describePairFailure(cause: unknown): string {
  const failure = classifyFailure(cause);
  if (failure.kind === "authDead") {
    return "That pairing link was already used or has expired. Make a new one in hbots Settings > Connections.";
  }
  if (cause instanceof RequestFailure) {
    return "Can't reach your laptop. It may be off or restarting.";
  }
  return cause instanceof Error ? cause.message : String(cause);
}
