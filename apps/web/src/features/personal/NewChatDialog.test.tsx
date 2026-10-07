import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { NewChatDialog } from "./NewChatDialog";

vi.mock("~/components/ui/alert-dialog", () => {
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: box,
    AlertDialogFooter: box,
    AlertDialogHeader: box,
    AlertDialogPopup: box,
    AlertDialogTitle: box,
  };
});
vi.mock("./useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("./useBotOpenChatNames", () => ({
  useBotOpenChatNames: () => [
    { threadId: "t1", title: "Main" },
    { threadId: "t2", title: "Weekly report" },
  ],
}));

function renderDialog(props: { error?: string | null } = {}) {
  const onStart = vi.fn();
  const onDraftChange = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <NewChatDialog
        open
        environmentId={"env" as EnvironmentId}
        botId="bot-1"
        botName="CTO"
        starting={false}
        error={props.error ?? null}
        onDraftChange={onDraftChange}
        onOpenChange={() => {}}
        onStart={onStart}
      />,
    );
  });
  const root = renderer.root;
  const input = () => root.findByType("input");
  const start = () =>
    root.find((node: ReactTestInstance) => node.props.type === "submit" && node.type !== "button");
  const alerts = () => root.findAllByProps({ role: "alert" });
  const type = (value: string) =>
    act(() => {
      input().props.onChange({ target: { value } });
    });
  const submit = () =>
    act(() => {
      root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
  return { input, start, alerts, type, submit, onStart, onDraftChange };
}

describe("NewChatDialog, unique names", () => {
  it("flags a name the bot's open chats already have and turns Start chat off", () => {
    const dialog = renderDialog();
    for (const typed of ["Main", "main ", "  MAIN", "weekly    REPORT"]) {
      dialog.type(typed);
      expect(dialog.alerts()[0]!.children).toEqual([
        `A chat called "${typed.trim()}" already exists`,
      ]);
      expect(dialog.input().props["aria-invalid"]).toBe(true);
      expect(dialog.start().props.disabled).toBe(true);
      dialog.submit();
      expect(dialog.onStart).not.toHaveBeenCalled();
    }
  });

  it("starts the chat with a free name or no name at all", () => {
    const dialog = renderDialog();
    dialog.type("Main 2");
    expect(dialog.alerts()).toHaveLength(0);
    expect(dialog.start().props.disabled).toBe(false);
    dialog.submit();
    expect(dialog.onStart).toHaveBeenCalledWith("Main 2");
    dialog.type("");
    expect(dialog.alerts()).toHaveLength(0);
    dialog.submit();
    expect(dialog.onStart).toHaveBeenLastCalledWith("");
  });

  it("shows the server's refusal under the field and tells the owner's edits", () => {
    const dialog = renderDialog({ error: 'A chat called "Plan" already exists' });
    expect(dialog.alerts()[0]!.children).toEqual(['A chat called "Plan" already exists']);
    expect(dialog.input().props["aria-invalid"]).toBe(true);
    dialog.type("Plan 2");
    expect(dialog.onDraftChange).toHaveBeenCalled();
  });
});
