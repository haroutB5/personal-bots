import type {
  PersonalBrowserActivityEvent,
  PersonalBrowserFrameMeta,
  PersonalBrowserStatus,
  PersonalBrowserStreamItem,
} from "@t3tools/contracts";

/** Everything the Computer screen renders from `personalBrowser.activity`. */
export interface ComputerFeed {
  readonly status: PersonalBrowserStatus | null;
  readonly events: ReadonlyArray<PersonalBrowserActivityEvent>;
}

export const EMPTY_COMPUTER_FEED: ComputerFeed = { status: null, events: [] };

const FEED_EVENT_LIMIT = 30;

export function reduceComputerFeed(
  feed: ComputerFeed,
  item: PersonalBrowserStreamItem,
): ComputerFeed {
  switch (item._tag) {
    case "Recent":
      return { ...feed, events: item.events.slice(-FEED_EVENT_LIMIT) };
    case "Activity":
      return feed.events.some((event) => event.id === item.event.id)
        ? feed
        : { ...feed, events: [...feed.events, item.event].slice(-FEED_EVENT_LIMIT) };
    case "Status":
      return { ...feed, status: item.status };
  }
}

export type ComputerDotTone = "live" | "pending" | "problem" | "idle";

export interface ComputerStateLabel {
  readonly label: string;
  readonly tone: ComputerDotTone;
}

/**
 * Header state. "Laptop offline" means the environment itself is unreachable;
 * the browser states come straight from the server.
 */
export function describeComputerState(input: {
  readonly status: PersonalBrowserStatus | null;
  readonly reachable: boolean;
  readonly loading: boolean;
  readonly agentTurnRunning?: boolean;
}): ComputerStateLabel {
  if (!input.reachable) return { label: "Laptop offline", tone: "idle" };
  if (input.status === null) {
    return input.loading
      ? { label: "Connecting", tone: "pending" }
      : { label: "Laptop offline", tone: "idle" };
  }
  if (input.status.helpRequest !== null) {
    return { label: "Needs your help", tone: "pending" };
  }
  switch (input.status.state) {
    case "connected":
      // Open but nobody at work in it (a lease holder whose turn ended, or no
      // one): the dot must not read live next to "left the browser open".
      // Callers that cannot tell (the Computer route) omit agentTurnRunning.
      return {
        label: "Connected",
        tone:
          input.agentTurnRunning === false && input.status.controller._tag !== "Human"
            ? "idle"
            : "live",
      };
    case "waiting_for_login":
      return { label: "Waiting for login", tone: "pending" };
    case "starting":
      return { label: "Starting browser", tone: "pending" };
    case "crashed":
      return { label: "Browser crashed", tone: "problem" };
    case "locked":
      return { label: "Browser profile locked", tone: "problem" };
    case "offline":
      return { label: "Browser not running", tone: "idle" };
  }
}

/** Chat the live agent lease belongs to, so "Back to chat" can return to it. */
export interface BackToChatTarget {
  readonly botId: string;
  readonly threadId: string;
}

export function backToChatTarget(status: PersonalBrowserStatus | null): BackToChatTarget | null {
  if (status?.controller._tag !== "Agent") return null;
  const { botId, threadId } = status.controller;
  return botId === null ? null : { botId, threadId };
}

/**
 * Where the Computer tab's "Back to chat" goes. The agent lease lapses 90
 * seconds after the bot's last op while the browser stays open for ten idle
 * minutes — exactly the stretch in which the user is looking at the bot's page
 * and wants its chat — so the server's durable `lastAgent` leads, and the live
 * controller is only the fallback (an older server sends no `lastAgent`).
 */
export function computerBackTarget(status: PersonalBrowserStatus | null): BackToChatTarget | null {
  return status?.lastAgent ?? backToChatTarget(status);
}

/** Whether the live agent browser lease belongs to this exact conversation. */
export function computerIsActiveForChat(
  status: PersonalBrowserStatus | null,
  chat: BackToChatTarget,
): boolean {
  const target = backToChatTarget(status);
  return target?.botId === chat.botId && target.threadId === chat.threadId;
}

/** Whether this exact conversation owns the open browser-help request. */
export function computerNeedsHelpForChat(
  status: PersonalBrowserStatus | null,
  chat: BackToChatTarget,
): boolean {
  const help = status?.helpRequest;
  return help?.botId === chat.botId && help.threadId === chat.threadId;
}

export interface ComputerChatLink {
  readonly text: string;
  readonly tone: ComputerDotTone;
}

/**
 * The one quiet line a conversation shows for the shared browser. The browser
 * itself lives on the Computer tab; this only says whether it has anything to
 * do with *this* chat, and stays a link to the tab either way.
 *
 * Another chat's help request is deliberately not surfaced here: it is that
 * chat's business, and the Computer tab shows it in full.
 */
export function computerChatLink(
  status: PersonalBrowserStatus | null,
  chat: BackToChatTarget,
  agentTurnRunning: boolean = false,
): ComputerChatLink {
  if (computerNeedsHelpForChat(status, chat)) {
    return { text: "Needs your help on the computer", tone: "pending" };
  }
  if (computerIsActiveForChat(status, chat)) {
    return agentTurnRunning
      ? { text: "Using the computer", tone: "live" }
      : { text: "Left the computer open", tone: "idle" };
  }
  return { text: "Computer", tone: "idle" };
}

/** Compact label for the chat panel bar. */
export function computerPanelDetail(
  status: PersonalBrowserStatus | null,
  stateLabel: string,
  agentTurnRunning: boolean = false,
): string {
  const agent = activeAgentLine(status, agentTurnRunning);
  if (agent !== null) return agent;
  if (status !== null && hasLiveViewport(status)) {
    const pageTitle = status.page?.title.trim();
    if (pageTitle) return pageTitle;
  }
  return stateLabel;
}

/** Honest agent/browser relationship; callers must opt in to the running claim. */
export function activeAgentLine(
  status: PersonalBrowserStatus | null,
  agentTurnRunning: boolean = false,
): string | null {
  if (status?.helpRequest !== null && status?.helpRequest !== undefined) {
    return `Needs your help: ${status.helpRequest.reason}`;
  }
  if (status?.controller._tag !== "Agent") return null;
  const name = status.controller.botName ?? "A bot";
  return agentTurnRunning ? `${name} is using the browser` : `${name} left the browser open`;
}

/** Whether there is a browser session to close at all. */
export function canCloseBrowser(status: PersonalBrowserStatus | null): boolean {
  return status !== null && status.state !== "offline";
}

/**
 * Confirm copy for closing the shared browser, or null when no confirmation is
 * needed. Only a live agent lease earns a prompt: closing under a working bot
 * interrupts it, while closing an idle browser (or one this device already
 * controls) is the plain, reversible thing the button says it is.
 */
export function closeBrowserConfirmMessage(
  status: PersonalBrowserStatus | null,
  agentTurnRunning: boolean = false,
): string | null {
  if (status === null || status.controller._tag === "Human") return null;
  // A pending help request is named, not quoted: its reason is the bot's own
  // sentence, usually already punctuated, and it outlives the lease TTL.
  if (status.helpRequest !== null) {
    return `${status.helpRequest.botName} is waiting for your help. Close it anyway?\nIts tabs are closed and the bot is told the browser closed.`;
  }
  if (status.controller._tag !== "Agent") return null;
  const line = activeAgentLine(status, agentTurnRunning) ?? "A bot left the browser open";
  return `${line}. Close it anyway?\nIts tabs are closed and the session ends.`;
}

export function hasLiveViewport(status: PersonalBrowserStatus | null): boolean {
  return status?.state === "connected" || status?.state === "waiting_for_login";
}

/** Maps a point on the displayed frame onto remote viewport CSS pixels. */
export function mapViewportPoint(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly meta: PersonalBrowserFrameMeta;
}): { readonly x: number; readonly y: number } | null {
  const { rect, meta } = input;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  return {
    x: clamp(((input.clientX - rect.left) / rect.width) * meta.width, meta.width),
    y: clamp(((input.clientY - rect.top) / rect.height) * meta.height, meta.height),
  };
}

export interface ViewportBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The largest box with the frame's aspect that fits in `container`, in whole
 * CSS pixels. The full-screen canvas is sized to exactly this, so the bitmap
 * scales uniformly and the canvas rect is the frame: taps map without offsets.
 */
export function fitFrame(container: ViewportBox, aspect: number): ViewportBox | null {
  if (!(container.width > 0 && container.height > 0 && aspect > 0 && Number.isFinite(aspect))) {
    return null;
  }
  // Nudged before flooring so an exact fit (a phone viewport the server
  // applied) is not lost to float error: 639.9999 must stay 640.
  const whole = (value: number) => Math.floor(value + 1e-6);
  return container.width / container.height > aspect
    ? { width: whole(container.height * aspect), height: container.height }
    : { width: container.width, height: whole(container.width / aspect) };
}

/** The last Viewport request, tied to the socket it went out on. */
export interface SentViewport<Client> {
  readonly client: Client;
  readonly key: string;
}

/**
 * Whether the controlling phone should (re)send its full-screen box. A new
 * socket starts from nothing (the server dropped the old socket's viewport),
 * so its first request goes out immediately; later changes (rotation, the
 * keyboard) are debounced by the caller. An unchanged box sends nothing.
 */
export function planViewportRequest<Client>(input: {
  readonly box: ViewportBox | null;
  readonly client: Client | null;
  readonly sent: SentViewport<Client> | null;
}): (ViewportBox & { readonly key: string; readonly immediate: boolean }) | null {
  const { box, client, sent } = input;
  if (box === null || client === null) return null;
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width <= 0 || height <= 0) return null;
  const key = `${width}x${height}`;
  if (sent !== null && sent.client === client && sent.key === key) return null;
  return { width, height, key, immediate: sent === null || sent.client !== client };
}

const ACTIVITY_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

export function formatActivityTime(iso: string): string {
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? ACTIVITY_TIME_FORMAT.format(millis) : "";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Route base shared by the viewport socket and file downloads. */
export const PERSONAL_BROWSER_ROUTE_BASE = "/api/personal/browser";
