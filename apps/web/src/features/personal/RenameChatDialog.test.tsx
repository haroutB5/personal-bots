import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  RENAME_CHAT_MAX_CHARS,
  renameChatDraftTitle,
  renameChatInitialTitle,
  useRenameChat,
} from "./renameChat";
import { RenameChatForm } from "./RenameChatDialog";

const command = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: { _tag: "Success" } as { readonly _tag: string; readonly cause?: unknown },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (args: unknown) => {
    command.calls.push(args);
    return command.result;
  },
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
// Base UI's dialog parts need a DOM; the form only uses the footer as a box.
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  command.calls = [];
  command.result = { _tag: "Success" };
});

function renderForm(initialTitle: string) {
  const onSave = vi.fn(async (_title: string): Promise<string | null> => null);
  const onCancel = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <RenameChatForm initialTitle={initialTitle} onSave={onSave} onCancel={onCancel} />,
    );
  });
  const root = renderer.root;
  const input = () => root.findByType("input");
  const save = () =>
    root.find((node: ReactTestInstance) => node.props.type === "submit" && node.type !== "button");
  const type = (value: string) =>
    act(() => {
      input().props.onChange({ target: { value } });
    });
  // The field as the page has it: focused while the keyboard is up.
  const field = { blur: vi.fn() };
  const formElement = {
    ownerDocument: { activeElement: field as unknown },
    contains: (node: unknown) => node === field,
  };
  const submit = async () => {
    await act(async () => {
      root
        .findByType("form")
        .props.onSubmit({ preventDefault: () => {}, currentTarget: formElement });
    });
  };
  const cancel = () =>
    root.find(
      (node: ReactTestInstance) => node.props.children === "Cancel" && node.type !== "button",
    );
  return { renderer, input, save, cancel, type, submit, field, formElement, onSave, onCancel };
}

describe("rename chat draft", () => {
  it("prefills the current title, empty for an untitled chat", () => {
    expect(renameChatInitialTitle("Trip plans")).toBe("Trip plans");
    expect(renameChatInitialTitle("New chat")).toBe("");
    expect(renameChatInitialTitle(undefined)).toBe("");
  });

  it("sends the trimmed title, nothing when empty or unchanged", () => {
    expect(renameChatDraftTitle("  Paris  ", "Trip plans")).toBe("Paris");
    expect(renameChatDraftTitle("   ", "Trip plans")).toBeNull();
    expect(renameChatDraftTitle(" Trip plans ", "Trip plans")).toBeNull();
    expect(renameChatDraftTitle("x".repeat(200), "")).toHaveLength(RENAME_CHAT_MAX_CHARS);
  });
});

describe("RenameChatForm", () => {
  it("prefills the field and caps its length", () => {
    const form = renderForm("Trip plans");
    expect(form.input().props.value).toBe("Trip plans");
    expect(form.input().props.maxLength).toBe(RENAME_CHAT_MAX_CHARS);
  });

  it("disables Save while the draft is unchanged, empty or only spaces", () => {
    const form = renderForm("Trip plans");
    expect(form.save().props.disabled).toBe(true);
    form.type("");
    expect(form.save().props.disabled).toBe(true);
    form.type("   ");
    expect(form.save().props.disabled).toBe(true);
    form.type(" Trip plans ");
    expect(form.save().props.disabled).toBe(true);
    form.type("Paris");
    expect(form.save().props.disabled).toBe(false);
  });

  it("saves the trimmed title on Enter", async () => {
    const form = renderForm("");
    form.type("  Paris trip ");
    await form.submit();
    expect(form.onSave).toHaveBeenCalledWith("Paris trip");
    expect(form.onCancel).not.toHaveBeenCalled();
  });

  it("keeps the field focused through a press on Save or Cancel", () => {
    // Refusing the press's default is what stops iOS blurring the field (and
    // dropping the keyboard and the sheet on it) before the click lands.
    const form = renderForm("Trip plans");
    form.type("Paris");
    for (const button of [form.save(), form.cancel()]) {
      for (const handler of ["onPointerDown", "onMouseDown"]) {
        const preventDefault = vi.fn();
        button.props[handler]({ preventDefault });
        expect(preventDefault, `${String(button.props.children)} ${handler}`).toHaveBeenCalled();
      }
    }
    expect(form.save().props.type).toBe("submit");
  });

  it("saves with one tap on Save while the keyboard is up, then drops the keyboard", async () => {
    const form = renderForm("Trip plans");
    form.type("Tennis");
    form.save().props.onPointerDown({ preventDefault: () => {} });
    form.save().props.onMouseDown({ preventDefault: () => {} });
    expect(form.field.blur).not.toHaveBeenCalled();
    // The click on a submit button submits the form: one tap, one save.
    await form.submit();
    expect(form.onSave).toHaveBeenCalledTimes(1);
    expect(form.onSave).toHaveBeenCalledWith("Tennis");
    expect(form.field.blur).toHaveBeenCalledTimes(1);
  });

  it("saves from the keyboard's return key (Done)", async () => {
    const form = renderForm("");
    expect(form.input().props.enterKeyHint).toBe("done");
    form.type("Tennis");
    // Return in a single-field form submits it.
    await form.submit();
    expect(form.onSave).toHaveBeenCalledWith("Tennis");
  });

  it("keeps the typed title when the keyboard's accessory check only closes it", () => {
    const form = renderForm("Trip plans");
    form.type("Tennis");
    // The accessory bar's check blurs the field and nothing else.
    expect(form.input().props.onBlur).toBeUndefined();
    expect(form.input().props.value).toBe("Tennis");
    expect(form.save().props.disabled).toBe(false);
    expect(form.onSave).not.toHaveBeenCalled();
  });

  it("keeps focus in the field when the save is refused", async () => {
    const form = renderForm("Trip plans");
    form.onSave.mockResolvedValueOnce("Thread not found.");
    form.type("Paris");
    await form.submit();
    expect(form.field.blur).not.toHaveBeenCalled();
  });

  it("does not save an unchanged title on Enter", async () => {
    const form = renderForm("Trip plans");
    await form.submit();
    expect(form.onSave).not.toHaveBeenCalled();
  });

  it("cancels on Escape without saving", () => {
    const form = renderForm("Trip plans");
    form.type("Paris");
    const preventDefault = vi.fn();
    act(() => {
      form.input().props.onKeyDown({ key: "Escape", preventDefault });
    });
    expect(form.onCancel).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(form.onSave).not.toHaveBeenCalled();
  });

  it("shows the server's refusal under the field", async () => {
    const form = renderForm("Trip plans");
    form.onSave.mockResolvedValueOnce("Thread not found.");
    form.type("Paris");
    await form.submit();
    const alert = form.renderer.root.findByProps({ role: "alert" });
    expect(alert.children).toEqual(["Thread not found."]);
    expect(form.input().props["aria-invalid"]).toBe(true);
  });
});

describe("useRenameChat", () => {
  const environmentId = "env-1" as EnvironmentId;
  const threadId = "thread-7" as ThreadId;

  it("sends the metadata rename with the chat's thread id and title", async () => {
    const rename = useRenameChat(environmentId);
    await expect(rename(threadId, "Paris trip")).resolves.toBeNull();
    expect(command.calls).toEqual([{ environmentId, input: { threadId, title: "Paris trip" } }]);
  });

  it("returns the server's message when it refuses", async () => {
    command.result = { _tag: "Failure", cause: Cause.fail({ message: "Thread not found." }) };
    const rename = useRenameChat(environmentId);
    await expect(rename(threadId, "Paris trip")).resolves.toBe("Thread not found.");
  });

  it("refuses without a connection", async () => {
    const rename = useRenameChat(null);
    await expect(rename(threadId, "Paris trip")).resolves.toBe("Not connected to your computer.");
    expect(command.calls).toEqual([]);
  });
});
