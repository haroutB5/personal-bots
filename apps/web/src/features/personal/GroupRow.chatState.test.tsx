import type { PersonalGroup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { groupLastActivityMs } from "./groupModel";
import { GroupRow } from "./GroupRow";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => (
    <a aria-label={(props as { "aria-label"?: string })["aria-label"]}>{children}</a>
  ),
}));
vi.mock("./GroupAvatarCluster", () => ({ GroupAvatarCluster: () => <span /> }));

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const group = (extra: Record<string, unknown> = {}) =>
  ({
    groupId: "g1",
    name: "Launch crew",
    members: [],
    updatedAt: DateTime.makeUnsafe(NOW - 5 * 3_600_000),
    archivedAt: null,
    newestMessage: { text: "Shipping tomorrow", hidden: false },
    ...extra,
  }) as unknown as PersonalGroup;

const html = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <GroupRow group={group(extra)} round={null} bots={[]} now={NOW} {...props} />,
  );

it("a pinned group row carries a small pin and says pinned", () => {
  const markup = html({ pinned: true });
  expect(markup).toContain('data-testid="pin-mark"');
  expect(markup).toContain("Launch crew, pinned group chat");
  expect(html()).not.toContain("pin-mark");
});

it("a snoozed group row shows when it wakes in place of its preview", () => {
  const markup = html({ wakeText: "Wakes today 18:00" });
  expect(markup).toContain("Wakes today 18:00");
  expect(markup).not.toContain("Shipping tomorrow");
  expect(markup).toContain("Launch crew, group chat, Wakes today 18:00");
});

it("an ordinary group row still shows its preview", () => {
  expect(html()).toContain("Shipping tomorrow");
});

it("a group whose snooze has run out sorts as if a message arrived at the wake time", () => {
  const woke = DateTime.makeUnsafe(NOW - 3_600_000);
  expect(groupLastActivityMs(group({ snoozedUntil: woke }), NOW)).toBe(NOW - 3_600_000);
});

it("a group still asleep keeps its own time, not the future wake time", () => {
  const later = DateTime.makeUnsafe(NOW + 3_600_000);
  expect(groupLastActivityMs(group({ snoozedUntil: later }), NOW)).toBe(NOW - 5 * 3_600_000);
});

it("an older wake time never moves the group back", () => {
  const old = DateTime.makeUnsafe(NOW - 50 * 3_600_000);
  expect(groupLastActivityMs(group({ snoozedUntil: old }), NOW)).toBe(NOW - 5 * 3_600_000);
});
