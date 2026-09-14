import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalRoutineId } from "@t3tools/contracts";

import { RoutineDetailScreen } from "./RoutineDetailScreen";

const HOOK_TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  copied: [] as Array<string>,
  confirmed: true as boolean,
  routine: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => {},
}));
vi.mock("~/confirmDialog", () => ({
  requestConfirmDialog: async () => state.confirmed,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: async (value: string) => {
    state.copied.push(value);
    return true;
  },
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        {
          botId: "bot-a",
          name: "Planner",
          sortOrder: 0,
          avatarShape: "roundedSquare",
          avatarColor: "#E5323B",
        },
      ],
    },
  }),
}));
vi.mock("./usePersonalAutomation", () => ({
  personalRoutineDelete: "delete",
  personalRoutinePause: "pause",
  personalRoutineRegenerateHook: "regenerate",
  personalRoutineResume: "resume",
  personalRoutineRunNow: "run-now",
  usePersonalRoutines: () => ({
    data: { routines: [state.routine], occurrences: [] },
    error: null,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (target: unknown) => {
    state.calls.push({ command, target });
    return { _tag: "Success", value: {} };
  },
}));

const ROUTINE_ID = PersonalRoutineId.make("routine-1");
const at = (iso: string) => DateTime.makeUnsafe(Date.parse(iso));

const baseRoutine = {
  routineId: ROUTINE_ID,
  botId: "bot-a",
  title: "PR watch",
  prompt: "Tell me what changed.",
  timeZone: "Europe/London",
  enabled: true,
  missedPolicy: "coalesce",
  nextDueAt: null,
  lastOccurrenceLocal: null,
  createdAt: at("2026-09-14T09:00:00Z"),
  updatedAt: at("2026-09-14T09:00:00Z"),
};

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.calls = [];
  state.copied = [];
  state.confirmed = true;
  vi.unstubAllGlobals();
});

const renderScreen = async (
  routine: Record<string, unknown>,
  origin = "https://box.example.ts.net",
) => {
  state.routine = routine;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { location: { origin } });
  await act(async () => {
    renderer = create(<RoutineDetailScreen routineId={ROUTINE_ID} />);
  });
  if (renderer === undefined) throw new Error("render failed");
  return renderer;
};

const eventRoutine = {
  ...baseRoutine,
  trigger: "event",
  schedule: null,
  eventLabel: "PR merged",
  hookToken: HOOK_TOKEN,
  lastFiredAt: null,
};

const scheduledRoutine = {
  ...baseRoutine,
  trigger: "schedule",
  schedule: { kind: "daily", time: "09:00" },
  eventLabel: null,
  hookToken: null,
  lastFiredAt: null,
  nextDueAt: at("2026-09-15T08:00:00Z"),
};

const hookUrlText = (tree: ReactTestRenderer) => {
  const node = tree.root.findAll((entry) => entry.props?.["data-testid"] === "routine-hook-url")[0];
  return node === undefined ? null : String(node.props.children);
};

/** Only the string leaves: button children include icon elements whose props hold circular fibers. */
const textOf = (children: unknown): string => {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children !== null && typeof children === "object" && "props" in children) {
    return textOf((children as { props: { children?: unknown } }).props.children);
  }
  return "";
};

const buttonWithText = (tree: ReactTestRenderer, text: string) =>
  tree.root.findAllByType("button").find((node) => textOf(node.props.children).includes(text));

const press = async (tree: ReactTestRenderer, text: string) => {
  const button = buttonWithText(tree, text);
  if (button === undefined) throw new Error(`no button ${text}`);
  await act(async () => button.props.onClick?.({ preventDefault: () => {} }));
};

describe("RoutineDetailScreen webhook panel", () => {
  it("shows the URL built from the origin the phone reached the server on", async () => {
    const tree = await renderScreen(eventRoutine);
    expect(hookUrlText(tree)).toBe(`https://box.example.ts.net/api/personal/hooks/${HOOK_TOKEN}`);
  });

  it("copies exactly the URL on screen", async () => {
    const tree = await renderScreen(eventRoutine);
    await press(tree, "Copy URL");
    expect(state.copied).toEqual([`https://box.example.ts.net/api/personal/hooks/${HOOK_TOKEN}`]);
    expect(buttonWithText(tree, "Copied")).toBeDefined();
  });

  it("regenerates only after the destructive confirm is accepted", async () => {
    state.confirmed = false;
    const tree = await renderScreen(eventRoutine);
    await press(tree, "Regenerate URL");
    expect(state.calls).toEqual([]);

    state.confirmed = true;
    await press(tree, "Regenerate URL");
    expect(state.calls).toEqual([
      {
        command: "regenerate",
        target: { environmentId: "env-1", input: { routineId: ROUTINE_ID } },
      },
    ]);
  });

  it("shows the event, not a next run that will never come", async () => {
    const tree = await renderScreen(eventRoutine);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("On event: PR merged");
    expect(text).not.toContain("Next run");
    expect(text).not.toContain("No more runs");
  });

  // The URL is built from the origin this page was served on, so opening the
  // app on the machine itself yields one nothing external can reach.
  it("warns when the page origin only works on this computer", async () => {
    const tunnel = JSON.stringify((await renderScreen(eventRoutine)).toJSON());
    expect(tunnel).not.toContain("only works on this computer");

    const tree = await renderScreen(eventRoutine, "http://localhost:38472");
    expect(hookUrlText(tree)).toBe(`http://localhost:38472/api/personal/hooks/${HOOK_TOKEN}`);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("only works on this computer");
    expect(text).toContain("T3 Connect");
  });

  it("leaves a scheduled routine without a webhook panel", async () => {
    const tree = await renderScreen(scheduledRoutine);
    expect(hookUrlText(tree)).toBeNull();
    expect(buttonWithText(tree, "Regenerate URL")).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toContain("Next run");
  });
});
