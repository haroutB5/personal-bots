import type { ResponseStreamingMode } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeAssistantStreamingFilter } from "../orchestration-v2/assistantStreaming.ts";

export const PERSONAL_LIVE_STREAMING_ENV = "T3CODE_PERSONAL_LIVE_STREAMING";
export const PERSONAL_LIVE_STREAM_INTERVAL_MS = 100;

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

type Event = ProviderAdapter.ProviderAdapterV2Event;
type Kind = "message" | "turnItem";

interface Streamed {
  readonly entity: string;
  readonly kind: Kind;
  readonly text: string;
  readonly streaming: boolean;
}

type Slot =
  | { readonly state: "open" }
  | { readonly state: "released" }
  | { readonly state: "held"; readonly event: Event };

/** One release window per streamed message, shared by the message and its turn item. */
interface Window {
  readonly at: number;
  readonly text: string;
  readonly message: Slot;
  readonly turnItem: Slot;
}

const OPEN: Slot = { state: "open" };
const RELEASED: Slot = { state: "released" };

function streamed(event: Event): Streamed | null {
  if (event.type === "message.updated" && event.message.role === "assistant") {
    const { id, text, streaming } = event.message;
    return { entity: `message:${id}`, kind: "message", text, streaming };
  }
  if (event.type !== "turn_item.updated") return null;
  const item = event.turnItem;
  if (item.type === "assistant_message")
    return {
      entity: `message:${item.messageId}`,
      kind: "turnItem",
      text: item.text,
      streaming: item.streaming,
    };
  if (item.type === "reasoning")
    return {
      entity: `reasoning:${item.id}`,
      kind: "turnItem",
      text: item.text,
      streaming: item.streaming,
    };
  return null;
}

const windowOf = (at: number, text: string, released: ReadonlySet<Kind>): Window => ({
  at,
  text,
  message: released.has("message") ? RELEASED : OPEN,
  turnItem: released.has("turnItem") ? RELEASED : OPEN,
});

const withSlot = (window: Window, kind: Kind, slot: Slot): Window => ({ ...window, [kind]: slot });

function makeLiveStreamingFilter(
  intervalMs: number,
): ReturnType<typeof makeAssistantStreamingFilter> {
  const windows = new Map<string, Window>();
  let nextDueAt: number | null = null;

  const hold = (entity: string, window: Window, kind: Kind, event: Event) => {
    windows.set(entity, withSlot(window, kind, { state: "held", event }));
    const dueAt = window.at + intervalMs;
    if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt;
  };

  return {
    filter(event, now) {
      if (
        event.type === "node.updated" &&
        event.node.kind === "assistant_message" &&
        event.node.status === "running"
      )
        return null;
      const item = streamed(event);
      if (item === null) return event;
      const { entity, kind, text } = item;
      const window = windows.get(entity);
      if (!item.streaming) {
        if (window === undefined) return event;
        const settled = withSlot(window, kind, RELEASED);
        if (settled.message.state === "held" || settled.turnItem.state === "held")
          windows.set(entity, settled);
        else windows.delete(entity);
        return event;
      }
      if (window === undefined || now - window.at >= intervalMs) {
        windows.set(entity, windowOf(now, text, new Set([kind])));
        return event;
      }
      if (window[kind].state === "open" && window.text === text) {
        windows.set(entity, withSlot(window, kind, RELEASED));
        return event;
      }
      hold(entity, window, kind, event);
      return null;
    },
    nextIdleFlushAt: () => nextDueAt,
    takeIdleFlushes(now) {
      const due: Array<Event> = [];
      nextDueAt = null;
      for (const [entity, window] of windows) {
        const held = [window.message, window.turnItem].flatMap((slot) =>
          slot.state === "held" ? [slot.event] : [],
        );
        const first = held[0];
        if (first === undefined) continue;
        const dueAt = window.at + intervalMs;
        if (dueAt > now) {
          if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt;
          continue;
        }
        due.push(...held);
        const released = new Set<Kind>();
        if (window.message.state === "held") released.add("message");
        if (window.turnItem.state === "held") released.add("turnItem");
        windows.set(entity, windowOf(now, streamed(first)?.text ?? window.text, released));
      }
      return due;
    },
  };
}

export const personalLiveStreamingOff = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => OFF_VALUES.has(env[PERSONAL_LIVE_STREAMING_ENV]?.trim().toLowerCase() ?? "");

/** Paragraph mode streams live, one release per message every 100 ms; turn mode and the off switch keep upstream. */
export function makePersonalAssistantStreamingFilter(
  mode: ResponseStreamingMode,
  options: { readonly intervalMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof makeAssistantStreamingFilter> {
  if (mode === "turn" || personalLiveStreamingOff(options.env))
    return makeAssistantStreamingFilter(mode);
  return makeLiveStreamingFilter(options.intervalMs ?? PERSONAL_LIVE_STREAM_INTERVAL_MS);
}
