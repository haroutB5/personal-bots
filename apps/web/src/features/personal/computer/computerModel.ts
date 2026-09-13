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
}): ComputerStateLabel {
  if (!input.reachable) return { label: "Laptop offline", tone: "idle" };
  if (input.status === null) {
    return input.loading
      ? { label: "Connecting", tone: "pending" }
      : { label: "Laptop offline", tone: "idle" };
  }
  switch (input.status.state) {
    case "connected":
      return { label: "Connected", tone: "live" };
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

/** "<Bot> is using the browser" only while an agent lease is live. */
export function activeAgentLine(status: PersonalBrowserStatus | null): string | null {
  if (status?.controller._tag !== "Agent") return null;
  return `${status.controller.botName ?? "An agent"} is using the browser`;
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
