/**
 * The mock layer behind `?computerMock=<scenario>` (or the `hbots.computer.mock`
 * storage key): typed scenarios for every state of the Computer tab, a small
 * store the commands mutate (take, hand back, stop, Allow once, Refuse), and
 * stand-in stages in place of the live sockets. It lets the tab be built and
 * screenshot before the server fields in Backend's contract exist. Loaded only
 * when the flag is set; the real tab never imports it.
 */
import type {
  EnvironmentId,
  PersonalBrowserActivityEvent,
  PersonalBrowserStatus,
  PersonalDesktopStatus,
  PersonalBotId,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo, useState, type JSX, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { EMPTY_COMPUTER_FEED } from "./computerModel";
import { ComputerDataOverride, type ComputerCommands, type ComputerData } from "./computerData";

export const MOCK_SCENARIOS = [
  "browser",
  "desktop",
  "control",
  "controlBrowser",
  "help",
  "helpCode",
  "helpLogin",
  "sensitive",
  "idle",
  "offline",
  "empty",
  "starting",
  "crashed",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const isScenario = (value: string): value is MockScenario =>
  (MOCK_SCENARIOS as ReadonlyArray<string>).includes(value);

const ASSISTANT = { botId: "mock-assistant", botName: "Assistant", threadId: "mock-thread-a" };
const DEVELOPER = { botId: "mock-developer", botName: "Developer", threadId: "mock-thread-d" };
const OPTIMIZER = { botId: "mock-optimizer", botName: "Optimizer", threadId: "mock-thread-o" };
const RESEARCHER = { botId: "mock-researcher", botName: "Researcher", threadId: "mock-thread-r" };

const brand = <T,>(value: string): T => value as unknown as T;

interface MockState {
  readonly status: PersonalBrowserStatus | null;
  readonly desktop: PersonalDesktopStatus;
  readonly events: ReadonlyArray<PersonalBrowserActivityEvent>;
  readonly reachable: boolean;
  readonly egress: boolean;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type EventDraft = readonly [
  id: string,
  ago: number,
  kind: PersonalBrowserActivityEvent["kind"],
  summary: string,
  bot: typeof ASSISTANT | null,
  extra?: Record<string, unknown>,
];

function event(draft: EventDraft): PersonalBrowserActivityEvent {
  const [id, ago, kind, summary, bot, extra] = draft;
  return {
    id,
    kind,
    summary,
    status: "succeeded",
    at: minutesAgo(ago),
    threadId: bot === null ? null : brand<ThreadId>(bot.threadId),
    botName: bot === null ? null : bot.botName,
    ...extra,
  } as PersonalBrowserActivityEvent;
}

function browserStatus(
  patch: Partial<PersonalBrowserStatus> & Record<string, unknown> = {},
): PersonalBrowserStatus {
  return {
    state: "connected",
    detail: null,
    lockedByPid: null,
    controller: {
      _tag: "Agent",
      threadId: brand<ThreadId>(ASSISTANT.threadId),
      botId: brand<PersonalBotId>(ASSISTANT.botId),
      botName: ASSISTANT.botName,
    },
    generation: 4,
    page: { url: "https://www.shop.example/cart", title: "Your cart · Shop" },
    helpRequest: null,
    dialog: null,
    lastAgent: {
      threadId: brand<ThreadId>(ASSISTANT.threadId),
      botId: brand<PersonalBotId>(ASSISTANT.botId),
    },
    viewers: 1,
    ...patch,
  };
}

function desktopStatus(patch: Partial<PersonalDesktopStatus> & Record<string, unknown> = {}) {
  return {
    available: true,
    holder: null,
    waiting: [],
    lastStop: null,
    stopHotkey: "Super+Shift+F12",
    focusedWindow: { title: "Terminal", windowClass: "kitty" },
    ...patch,
  } as PersonalDesktopStatus;
}

const desktopHolder = (bot: typeof DEVELOPER, minutes: number) => ({
  threadId: bot.threadId,
  botId: bot.botId,
  botName: bot.botName,
  since: minutesAgo(minutes),
  lastActionAt: minutesAgo(0.2),
});

const BROWSER_EVENTS: ReadonlyArray<EventDraft> = [
  ["e1", 9, "open", "Opened shop.example", ASSISTANT],
  ["e2", 7, "navigate", "Opened Your cart", ASSISTANT],
  ["e3", 5, "click", "Clicked Checkout", ASSISTANT],
  ["e4", 4, "type", "Typed into Email", ASSISTANT],
  ["e5", 3, "screenshot", "Saved a screenshot", ASSISTANT],
  ["e6", 0.4, "click", "Clicked Buy", ASSISTANT],
];

const DESKTOP_EVENTS: ReadonlyArray<EventDraft> = [
  ["d1", 6, "click", "Clicked Save", DEVELOPER, { source: "desktop", x: 640, y: 380 }],
  ["d2", 5, "type", "Typed text", DEVELOPER, { source: "desktop", chars: 24 }],
  ["d3", 0.3, "press", "Pressed Ctrl+S", DEVELOPER, { source: "desktop" }],
];

const HELP = (reason: string, kind: string, origin: string) => ({
  threadId: brand<ThreadId>(ASSISTANT.threadId),
  botId: brand<PersonalBotId>(ASSISTANT.botId),
  botName: ASSISTANT.botName,
  reason,
  requestedAt: minutesAgo(1),
  kind,
  origin,
});

const YOU_BROWSER = { _tag: "Human", self: true, connected: true } as const;

function scenarioState(name: MockScenario): MockState {
  const base: MockState = {
    status: browserStatus({
      waiting: [{ ...RESEARCHER }],
    } as Partial<PersonalBrowserStatus>),
    desktop: desktopStatus(),
    events: [...BROWSER_EVENTS, ...DESKTOP_EVENTS].map(event),
    reachable: true,
    egress: true,
  };
  switch (name) {
    case "browser":
      return {
        ...base,
        // The browser bot acted last, so Auto opens on Browser.
        events: [
          ...BROWSER_EVENTS,
          ...DESKTOP_EVENTS.map(([id, ago, ...rest]): EventDraft => [id, ago + 2, ...rest]),
        ].map(event),
        desktop: desktopStatus({ holder: desktopHolder(DEVELOPER, 6) }),
      };
    case "desktop":
      return {
        ...base,
        status: browserStatus({
          controller: { _tag: "None" },
        }),
        desktop: desktopStatus({
          holder: desktopHolder(DEVELOPER, 6),
          waiting: [{ ...ASSISTANT }],
        }),
      };
    case "control":
      return {
        ...base,
        status: browserStatus({ controller: { _tag: "None" } }),
        desktop: desktopStatus({ holder: desktopHolder(DEVELOPER, 6) }),
      };
    case "controlBrowser":
      return {
        ...base,
        status: browserStatus({
          controller: YOU_BROWSER,
          helpRequest: HELP("Sign in to continue", "login", "shop.example"),
        } as Partial<PersonalBrowserStatus>),
      };
    case "help":
      return {
        ...base,
        status: browserStatus({
          controller: { _tag: "None" },
          helpRequest: HELP("Solve the check to continue", "captcha", "shop.example"),
        } as Partial<PersonalBrowserStatus>),
      };
    case "helpCode":
      return {
        ...base,
        status: browserStatus({
          controller: { _tag: "None" },
          helpRequest: HELP("Enter the 6-digit code", "code", "bank.example"),
        } as Partial<PersonalBrowserStatus>),
      };
    case "helpLogin":
      return {
        ...base,
        status: browserStatus({
          controller: { _tag: "None" },
          helpRequest: HELP("Sign in to continue", "login", "mail.example"),
        } as Partial<PersonalBrowserStatus>),
      };
    case "sensitive":
      return {
        ...base,
        status: browserStatus({
          egressPause: {
            ...ASSISTANT,
            sources: "Chase, Gmail",
            destination: "slack.com",
            requestedAt: minutesAgo(0.5),
          },
        } as Partial<PersonalBrowserStatus>),
      };
    case "idle":
      return {
        ...base,
        status: browserStatus({
          state: "offline",
          controller: { _tag: "None" },
          page: null,
          lastStop: minutesAgo(26),
        } as Partial<PersonalBrowserStatus>),
        events: [
          event(["i1", 50, "open", "Opened a tab", OPTIMIZER, { status: "failed" }]),
          event(["i2", 45, "control", "You took control", null]),
          event(["i3", 40, "download", "Downloaded receipt.pdf", ASSISTANT]),
          event(["i4", 36, "control", "You handed back to Assistant", null]),
        ],
      };
    case "offline":
      return { ...base, status: null, reachable: false, events: [] };
    case "empty":
      return {
        ...base,
        status: browserStatus({
          state: "offline",
          controller: { _tag: "None" },
          page: null,
          lastAgent: null,
        }),
        events: [],
      };
    case "starting":
      return { ...base, status: browserStatus({ state: "starting", page: null }) };
    case "crashed":
      return {
        ...base,
        status: browserStatus({
          state: "crashed",
          detail: "Brave stopped unexpectedly.",
          controller: { _tag: "None" },
          page: null,
        }),
      };
  }
}

/** Provides mock data to the Computer tab in place of the live feed. */
export function ComputerMockProvider(props: {
  readonly scenario: string;
  readonly children: ReactNode;
}): JSX.Element {
  const name: MockScenario = isScenario(props.scenario) ? props.scenario : "browser";
  const [state, setState] = useState<MockState>(() => scenarioState(name));

  const commands = useMemo<ComputerCommands>(() => {
    const you = (summary: string): PersonalBrowserActivityEvent =>
      event([`you-${Date.now()}`, 0, "control", summary, null]);
    return {
      takeBrowser: async () => {
        setState((current) => ({
          ...current,
          status:
            current.status === null
              ? null
              : { ...current.status, state: "connected", controller: YOU_BROWSER },
          events: [...current.events, you("You took control")],
        }));
        return null;
      },
      returnBrowser: async () => {
        setState((current) => ({
          ...current,
          status:
            current.status === null
              ? null
              : {
                  ...current.status,
                  controller: {
                    _tag: "Agent",
                    threadId: brand<ThreadId>(ASSISTANT.threadId),
                    botId: brand<PersonalBotId>(ASSISTANT.botId),
                    botName: ASSISTANT.botName,
                  },
                  helpRequest: null,
                },
          events: [...current.events, you("You handed it back")],
        }));
        return null;
      },
      closeBrowser: async () => {
        setState((current) => ({
          ...current,
          status:
            current.status === null
              ? null
              : {
                  ...current.status,
                  state: "offline",
                  controller: { _tag: "None" },
                  page: null,
                  lastAgent: null,
                },
        }));
        return null;
      },
      stopDesktop: async () => {
        setState((current) => ({ ...current, desktop: { ...current.desktop, holder: null } }));
        return null;
      },
      egress: {
        available: state.egress,
        approve: async () => {
          setState((current) => ({
            ...current,
            status:
              current.status === null
                ? null
                : ({ ...current.status, egressPause: null } as PersonalBrowserStatus),
          }));
          return null;
        },
        refuse: async () => {
          setState((current) => ({
            ...current,
            status:
              current.status === null
                ? null
                : ({ ...current.status, egressPause: null } as PersonalBrowserStatus),
          }));
          return null;
        },
      },
    };
  }, [state.egress]);

  const data = useMemo<ComputerData>(
    () => ({
      feed: state.reachable ? { status: state.status, events: state.events } : EMPTY_COMPUTER_FEED,
      error: state.reachable ? null : "offline",
      loading: false,
      desktop: state.reachable ? state.desktop : null,
      commands,
      mock: name,
    }),
    [state, commands, name],
  );
  return (
    <ComputerDataOverride.Provider value={data}>{props.children}</ComputerDataOverride.Provider>
  );
}

/** What replaces the live socket: a flat drawing of the page or the screen. */
export function MockStage(props: {
  readonly scenario: string;
  readonly source: "browser" | "desktop";
  readonly controlled: boolean;
  readonly fill: boolean;
}): JSX.Element {
  return props.source === "browser" ? (
    <div
      data-testid="mock-browser-stage"
      className={cn(
        "flex flex-col gap-3 bg-[#f3efe6] p-4 text-[#1f1d19]",
        props.fill ? "h-full" : "aspect-[390/560]",
      )}
    >
      <div className="h-6 w-2/5 rounded bg-[#1f1d19]/80" />
      <div className="h-24 rounded-lg bg-[#d9d2c1]" />
      <div className="flex items-center gap-3">
        <div className="size-14 rounded-lg bg-[#c9bfa8]" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-3 w-4/5 rounded bg-[#1f1d19]/60" />
          <div className="h-3 w-2/5 rounded bg-[#1f1d19]/40" />
        </div>
        <div className="h-3 w-10 rounded bg-[#1f1d19]/60" />
      </div>
      <div className="flex items-center gap-3">
        <div className="size-14 rounded-lg bg-[#c9bfa8]" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-3 w-3/5 rounded bg-[#1f1d19]/60" />
          <div className="h-3 w-1/3 rounded bg-[#1f1d19]/40" />
        </div>
        <div className="h-3 w-10 rounded bg-[#1f1d19]/60" />
      </div>
      <div className="mt-auto flex h-11 items-center justify-center rounded-lg bg-[#1f1d19] text-[14px] font-semibold text-[#f3efe6]">
        Checkout
      </div>
    </div>
  ) : (
    <div
      data-testid="mock-desktop-stage"
      className={cn(
        "relative flex bg-gradient-to-br from-[#16202b] to-[#0d1117] p-4",
        props.fill ? "h-full" : "aspect-[16/10]",
      )}
    >
      <div className="flex w-3/5 flex-col rounded-lg border border-white/10 bg-[#0b0f14]/90">
        <div className="flex h-6 items-center gap-1.5 border-b border-white/10 px-2">
          <span className="size-2 rounded-full bg-[#e5534b]" />
          <span className="size-2 rounded-full bg-[#d4a72c]" />
          <span className="size-2 rounded-full bg-[#3ecf6b]" />
        </div>
        <div className="flex flex-col gap-1.5 p-3 font-mono text-[11px] text-[#9fb4c9]">
          <span>$ pnpm test</span>
          <span className="text-[#3ecf6b]"> ✓ 214 passed</span>
          <span>$ git status</span>
          <span>$</span>
        </div>
      </div>
      <div className="absolute right-4 bottom-4 left-4 h-7 rounded-full bg-white/10" />
    </div>
  );
}

export type { EnvironmentId };
