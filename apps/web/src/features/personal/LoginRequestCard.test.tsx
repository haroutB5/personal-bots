import {
  PersonalBotId,
  PersonalTaskId,
  ThreadId,
  type PersonalLoginRequest,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { LoginRequestCard } from "./LoginRequestCard";
import { placeLoginRequestCards } from "./conversationModel";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const REQUEST: PersonalLoginRequest = {
  requestId: "login-1",
  taskId: PersonalTaskId.make("task-1"),
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  tabId: "tab-1",
  origin: "https://example.test",
  label: "Example",
  reason: "Sign in to check your order.",
  status: "pending",
  saved: false,
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 600_000).toISOString(),
};
let renderer: ReactTestRenderer;
const provide = vi.fn();
const cancel = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  provide.mockClear();
  cancel.mockClear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(request = REQUEST) {
  await act(async () => {
    renderer = create(
      <LoginRequestCard request={request} botName="Scout" onProvide={provide} onCancel={cancel} />,
    );
  });
}
async function fill() {
  await act(async () => {
    renderer.root
      .findByProps({ name: "username" })
      .props.onChange({ target: { value: "dummy-user" } });
    renderer.root
      .findByProps({ name: "password" })
      .props.onChange({ target: { value: "dummy-password" } });
  });
}
it("defaults to saving, redacts both fields and removes them before any second submit", async () => {
  await render();
  expect(renderer.root.findByProps({ role: "switch" }).props.checked).toBe(true);
  await fill();
  const submit = renderer.root.findByType("form").props.onSubmit;
  await act(async () => {
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  expect(provide).toHaveBeenCalledTimes(1);
  const [requestId, username, password, save] = provide.mock.calls[0]!;
  expect(requestId).toBe("login-1");
  expect(Redacted.isRedacted(username)).toBe(true);
  expect(Redacted.isRedacted(password)).toBe(true);
  expect(Redacted.value(username)).toBe("dummy-user");
  expect(Redacted.value(password)).toBe("dummy-password");
  expect(save).toBe(true);
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("dummy-password");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("dummy-user");
});
it("sends the user's save-off choice and allows password visibility to be toggled", async () => {
  await render();
  await fill();
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Show password" }).props.onClick();
    renderer.root.findByProps({ role: "switch" }).props.onChange({ target: { checked: false } });
  });
  expect(renderer.root.findByProps({ name: "password" }).props.type).toBe("text");
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Hide password" }).props.onClick(),
  );
  expect(renderer.root.findByProps({ name: "password" }).props.type).toBe("password");
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(provide.mock.calls[0]![3]).toBe(false);
});
it("cancel removes entered details and cannot send them afterward", async () => {
  await render();
  await fill();
  const submit = renderer.root.findByType("form").props.onSubmit;
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes("Cancel"))!;
  await act(async () => {
    button.props.onClick();
    submit({ preventDefault() {} });
  });
  expect(cancel).toHaveBeenCalledExactlyOnceWith("login-1");
  expect(provide).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
});
it("expires while open and rejects a submit captured before its deadline", async () => {
  await render();
  await fill();
  const submit = renderer.root.findByType("form").props.onSubmit;
  await act(async () => {
    vi.advanceTimersByTime(600_000);
  });
  await act(async () => submit({ preventDefault() {} }));
  expect(provide).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("expired");
});
it.each(["filling", "filled", "cancelled", "expired", "origin-mismatch", "fill-failed"] as const)(
  "shows %s without credential fields",
  async (status) => {
    await render({ ...REQUEST, status });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(1);
  },
);
it("places open requests last and puts completed requests back at their original time", () => {
  const items = [
    { kind: "divider" as const, id: "before", at: new Date(NOW - 1_000) },
    { kind: "divider" as const, id: "after", at: new Date(NOW + 1_000) },
  ];
  expect(placeLoginRequestCards(items, [REQUEST]).map((item) => item.id)).toEqual([
    "before",
    "after",
    "login:login-1",
  ]);
  expect(
    placeLoginRequestCards(items, [{ ...REQUEST, status: "filled" }]).map((item) => item.id),
  ).toEqual(["before", "login:login-1", "after"]);
});
