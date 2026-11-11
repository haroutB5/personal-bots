import { describe, expect, it } from "vite-plus/test";

import type { WidgetEntry } from "./launcher/nativeLauncher";
import { buildWidgetFeed, MAX_WIDGET_BOTS } from "./widgetFeed";

const bot = (
  botId: string,
  name: string,
  fields: { pinned?: boolean; enabled?: boolean } = {},
) => ({
  botId,
  name,
  ...fields,
});

describe("the widget feed", () => {
  it("is empty with nothing pinned and nothing working", () => {
    expect(buildWidgetFeed([bot("a", "Juno")], new Set())).toEqual([]);
  });

  it("lists pinned bots, and a working bot even if it is not pinned, working first", () => {
    const feed = buildWidgetFeed(
      [bot("a", "Juno", { pinned: true }), bot("b", "Forge"), bot("c", "Nova", { pinned: true })],
      new Set(["b", "c"]),
    );
    expect(feed).toEqual([
      { botId: "b", name: "Forge", working: true },
      { botId: "c", name: "Nova", working: true },
      { botId: "a", name: "Juno", working: false },
    ]);
  });

  it("skips disabled bots and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, `Bot ${i}`, { pinned: true }));
    expect(buildWidgetFeed(many, new Set())).toHaveLength(MAX_WIDGET_BOTS);
    expect(buildWidgetFeed([bot("a", "Off", { pinned: true, enabled: false })], new Set())).toEqual(
      [],
    );
  });

  describe("the shape cannot carry message text", () => {
    // A bot record that grows text fields. The widget feed must not copy any of them.
    const leaky = {
      ...bot("a", "Juno", { pinned: true }),
      newestMessage: { text: "my bank pin is 1234" },
      progressNote: "reading secrets.env",
      threadTitles: ["private chat"],
      preview: "hello there",
      description: "free text",
    };

    it("copies exactly botId, name and working", () => {
      const [entry] = buildWidgetFeed([leaky], new Set(["a"]));
      expect(Object.keys(entry ?? {}).toSorted()).toEqual(["botId", "name", "working"]);
    });

    it("leaves none of the leaky values anywhere in the serialized feed", () => {
      const json = JSON.stringify(buildWidgetFeed([leaky], new Set(["a"])));
      for (const secret of [
        "bank pin",
        "secrets.env",
        "private chat",
        "hello there",
        "free text",
      ]) {
        expect(json).not.toContain(secret);
      }
    });

    it("is a type error to add a text field to an entry", () => {
      const ok: WidgetEntry = { botId: "a", name: "Juno", working: true };
      // @ts-expect-error The feed type has no room for message text.
      const bad: WidgetEntry = { ...ok, text: "hello" };
      expect(Object.keys(ok)).toHaveLength(3);
      expect(bad).toBeDefined();
    });
  });
});
