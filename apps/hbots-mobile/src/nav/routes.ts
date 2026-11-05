/**
 * The shell's typed route stack. Back is computed from the stack that opened a
 * screen, never from an untyped history, so every entry in SPEC.md section 7
 * is one testable function.
 */

export type TabName = "bots" | "tasks" | "computer" | "files";

export type Origin = "bots" | "team" | "notification" | "share" | "deeplink" | "tab-root";

export type Route =
  | { readonly kind: "tab"; readonly tab: TabName }
  | { readonly kind: "team" }
  | { readonly kind: "teamNew" }
  | { readonly kind: "teamRemoved" }
  | {
      readonly kind: "chat";
      readonly botId: string;
      readonly threadId: string;
      readonly requestId?: string;
    }
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "botNew" }
  | { readonly kind: "botEdit"; readonly botId: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "groupNew" }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "routine"; readonly routineId: string }
  | { readonly kind: "settings" }
  | { readonly kind: "thisPhone" }
  | { readonly kind: "stop" };

export interface NavState {
  readonly stack: ReadonlyArray<Route>;
}

const BOTS: Route = { kind: "tab", tab: "bots" };

export const initialNav: NavState = { stack: [BOTS] };

export function tabRoot(tab: TabName): Route {
  return { kind: "tab", tab };
}

/** Tap on the bottom bar: every tab root replaces the stack. */
export function switchTab(state: NavState, tab: TabName): NavState {
  if (tab === "bots") {
    const onBotsRoot = state.stack.length === 1 && state.stack[0]?.kind === "tab";
    return onBotsRoot ? state : { stack: [BOTS] };
  }
  return { stack: [tabRoot(tab)] };
}

export function push(state: NavState, route: Route): NavState {
  return { stack: [...state.stack, route] };
}

export function replaceTop(state: NavState, route: Route): NavState {
  if (state.stack.length === 0) {
    return { stack: [route] };
  }
  return { stack: [...state.stack.slice(0, -1), route] };
}

/**
 * One back press. Null means the app itself leaves (the last press on Bots
 * home), so the caller lets the system handle it.
 */
export function back(state: NavState): NavState | null {
  const current = state.stack[state.stack.length - 1];
  if (current === undefined) {
    return null;
  }
  if (state.stack.length > 1) {
    return { stack: state.stack.slice(0, -1) };
  }
  if (current.kind === "tab" && current.tab !== "bots") {
    return { stack: [BOTS] };
  }
  return null;
}

/** The explicit stack a chat opens on, per SPEC.md section 7. */
export function chatStack(origin: Origin): ReadonlyArray<Route> {
  const chat = (): Route => ({ kind: "chat", botId: "", threadId: "" });
  if (origin === "team") {
    return [BOTS, { kind: "team" }, chat()];
  }
  return [BOTS, chat()];
}

export function conversation(
  state: NavState,
  botId: string,
  threadId: string,
  origin: Origin,
  requestId?: string,
): NavState {
  const stack = chatStack(origin).map((route): Route => {
    if (route.kind !== "chat") return route;
    return requestId === undefined
      ? { kind: "chat", botId, threadId }
      : { kind: "chat", botId, threadId, requestId };
  });
  return { stack };
}

export function parseDeepLink(raw: string): NavState | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "hbots:") {
    return null;
  }
  const parts = [
    ...(url.host.length > 0 ? [url.host] : []),
    ...url.pathname.split("/").filter((part) => part.length > 0),
  ];
  if (parts.length === 0) {
    return null;
  }
  const [head, first, second] = parts;
  switch (head) {
    case "chat":
      if (first === undefined || second === undefined) {
        return null;
      }
      return conversation(
        initialNav,
        first,
        second,
        "deeplink",
        url.searchParams.get("request") ?? undefined,
      );
    case "bot":
      if (first === undefined) return null;
      return second === "edit"
        ? { stack: [BOTS, { kind: "bot", botId: first }, { kind: "botEdit", botId: first }] }
        : { stack: [BOTS, { kind: "bot", botId: first }] };
    case "group":
      if (first === undefined) return null;
      return { stack: [BOTS, { kind: "group", groupId: first }] };
    case "groupNew":
      return { stack: [BOTS, { kind: "groupNew" }] };
    case "team":
      return { stack: [BOTS, { kind: "team" }] };
    case "teamNew":
      return { stack: [BOTS, { kind: "teamNew" }] };
    case "task":
      return first === undefined ? null : { stack: [BOTS, { kind: "task", taskId: first }] };
    case "settings":
      if (first === "removed") {
        return { stack: [BOTS, { kind: "settings" }, { kind: "teamRemoved" }] };
      }
      return first === "this-phone"
        ? { stack: [BOTS, { kind: "settings" }, { kind: "thisPhone" }] }
        : { stack: [BOTS, { kind: "settings" }] };
    case "stop":
      return { stack: [BOTS, { kind: "stop" }] };
    default:
      return null;
  }
}
