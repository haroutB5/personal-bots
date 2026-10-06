import type { EnvironmentId, PersonalBotSearchMessageHit } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { canSearchMessages, MESSAGE_SEARCH_DEBOUNCE_MS } from "./chatSearch";

/** One-shot read: what the owner and the bots said, matching a query. */
export const personalMessageSearch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:search-messages",
  tag: WS_METHODS.personalBotsSearchMessages,
});

export interface MessageSearchState {
  /** idle: no search to run; loading: asked and waiting; ready: answered; error: could not ask. */
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly hits: ReadonlyArray<PersonalBotSearchMessageHit>;
  /** The server stopped at its cap: more chats may match. */
  readonly capped: boolean;
}

const IDLE: MessageSearchState = { status: "idle", hits: [], capped: false };
const FAILED: MessageSearchState = { status: "error", hits: [], capped: false };

/**
 * Searches inside messages while the owner types: waits for a pause, asks only
 * for a query the server accepts, and drops an answer to a query that has been
 * replaced since. Hits of the previous query stay up while the next is on its
 * way. A failure is quiet: no hits, no throw.
 */
export function useMessageSearch(
  environmentId: EnvironmentId | null,
  query: string,
): MessageSearchState {
  const search = useAtomCommand(personalMessageSearch, { reportFailure: false });
  const searchRef = useRef(search);
  searchRef.current = search;
  const requestRef = useRef(0);
  const [state, setState] = useState<MessageSearchState>(IDLE);
  const text = query.trim();
  const searchable = environmentId !== null && canSearchMessages(text);

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (!searchable) {
      setState(IDLE);
      return;
    }
    setState((current) =>
      current.status === "loading" ? current : { ...current, status: "loading" },
    );
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await searchRef.current({ environmentId, input: { query: text } });
          if (requestRef.current !== request) return;
          setState(
            result._tag === "Success"
              ? { status: "ready", hits: result.value.hits, capped: result.value.capped }
              : FAILED,
          );
        } catch {
          if (requestRef.current === request) setState(FAILED);
        }
      })();
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // An answer still on its way belongs to a query that is gone.
      requestRef.current += 1;
    };
  }, [environmentId, searchable, text]);

  return searchable ? state : IDLE;
}
