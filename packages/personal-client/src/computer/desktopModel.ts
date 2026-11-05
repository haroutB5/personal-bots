import type {
  PersonalDesktopActivityEvent,
  PersonalDesktopStatus,
  PersonalDesktopStreamItem,
} from "@t3tools/contracts";

/** The user's own PC, as far as the Computer tab needs it without a runtime. */
export interface DesktopAccess {
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
}

/** The same query the browser viewport socket uses. */
function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
}

const DESKTOP_EVENT_LIMIT = 30;
export const EMPTY_DESKTOP_EVENTS: ReadonlyArray<PersonalDesktopActivityEvent> = [];

export function reduceDesktopEvents(
  events: ReadonlyArray<PersonalDesktopActivityEvent>,
  item: PersonalDesktopStreamItem,
): ReadonlyArray<PersonalDesktopActivityEvent> {
  switch (item._tag) {
    case "Recent":
      return item.events.slice(-DESKTOP_EVENT_LIMIT);
    case "Activity":
      return events.some((event) => event.id === item.event.id)
        ? events
        : [...events, item.event].slice(-DESKTOP_EVENT_LIMIT);
  }
}

/** What a chat's desktop line says, or null when this chat is not on the PC. */
export function desktopLineFor(
  status: PersonalDesktopStatus | null,
  threadId: string,
):
  | { readonly kind: "using"; readonly text: string }
  | { readonly kind: "waiting"; readonly text: string }
  | null {
  if (status === null) return null;
  if (status.holder?.threadId === threadId) {
    return { kind: "using", text: `Using your PC · press ${status.stopHotkey} on the PC to stop` };
  }
  if (status.waiting.some((entry) => entry.threadId === threadId)) {
    return {
      kind: "waiting",
      text:
        status.holder === null
          ? "Waiting for the computer"
          : status.holder.kind === "user"
            ? "Waiting for the computer · you are using it"
            : `Waiting for the computer · ${status.holder.botName} is using it`,
    };
  }
  return null;
}

/**
 * The live view socket's URL, from the Computer tab's own access (same
 * cookie or `wsTicket`). The access base ends in the browser's route base;
 * the desktop path swaps just that suffix, keeping any path prefix.
 */
export function desktopStreamUrl(
  access: DesktopAccess,
  browserRouteBase: string,
  desktopPath: string,
): string | null {
  if (!access.wsBase.endsWith(browserRouteBase)) return null;
  const origin = access.wsBase.slice(0, -browserRouteBase.length);
  return withQuery(`${origin}${desktopPath}`, access.query);
}

/** Who has the PC, for the Desktop view's status line. */
export function desktopHolderLine(status: PersonalDesktopStatus | null): {
  readonly text: string;
  readonly busy: boolean;
} {
  if (status === null) return { text: "Checking the PC", busy: false };
  if (!status.available)
    return { text: "The live view needs the bots server on Windows", busy: false };
  const waiting = status.waiting.length;
  const queue = waiting === 0 ? "" : ` · ${waiting} waiting`;
  if (status.holder?.kind === "user") {
    return { text: `You are controlling your PC${queue}`, busy: true };
  }
  if (status.holder !== null) {
    return { text: `${status.holder.botName} is using your PC${queue}`, busy: true };
  }
  return { text: `No bot is using your PC${queue}`, busy: false };
}
