import type { ReactNode } from "react";

import type { EnvironmentId, PersonalBot, PersonalTask } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DelegationCard } from "./DelegationCard";

const { cancel } = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => async () => undefined,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({ children }: { children: ReactNode }) => children,
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuItem: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  workEntryDisplayLabel: () => "step",
}));
vi.mock("~/session-logic", () => ({ deriveWorkLogEntries: () => [] }));
vi.mock("~/state/entities", () => ({ useThreadDetail: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => cancel }));
vi.mock("./usePersonalAutomation", () => ({ personalTaskCancel: {} }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

const bot = {
  botId: "bot-devops",
  name: "DevOps",
  avatarShape: "circle",
  avatarColor: "#000",
} as unknown as PersonalBot;

const task = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    taskId: "task-1",
    botId: "bot-devops",
    title: "matchday: deploy 0.167.11",
    status: "running",
    threadId: "thread-child",
    errorMessage: null,
    createdAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  }) as unknown as PersonalTask;

let renderer: ReactTestRenderer | undefined;

const render = async (value: PersonalTask) => {
  await act(async () => {
    renderer = create(
      <DelegationCard
        environmentId={"env-1" as EnvironmentId}
        task={value}
        bot={bot}
        providerLabel="Claude Code"
        waitingFor={null}
      />,
    );
  });
};

describe("DelegationCard", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    cancel.mockClear();
    vi.unstubAllGlobals();
  });

  it("opens the child's chat from the card and interrupts from the card", async () => {
    await render(task());

    const open = renderer!.root.findByProps({
      "aria-label": "Open DevOps's chat for this task",
    });
    expect(open.props.params).toEqual({ botId: "bot-devops", threadId: "thread-child" });

    // Interrupt is on the card, not inside the "..." menu.
    const interrupt = renderer!.root.findAll(
      (node) => node.type === "button" && node.children.includes("Interrupt"),
    );
    expect(interrupt).toHaveLength(1);
    await act(async () => interrupt[0]!.props.onClick());
    expect(cancel).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { taskId: "task-1" },
    });
  });

  it("is not tappable when the task has no chat yet", async () => {
    await render(task({ threadId: null, status: "queued" }));

    expect(
      renderer!.root.findAllByProps({ "aria-label": "Open DevOps's chat for this task" }),
    ).toEqual([]);
    expect(renderer!.root.findAllByProps({ "aria-label": "Options for DevOps's task" })).toEqual(
      [],
    );
    // A queued task can still be called off, but "Interrupt" would be a lie.
    expect(
      renderer!.root.findAll((node) => node.type === "button" && node.children.includes("Cancel")),
    ).toHaveLength(1);
  });
});
