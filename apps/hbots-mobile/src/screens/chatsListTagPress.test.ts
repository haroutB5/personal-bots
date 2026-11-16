import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const screen = NodeFS.readFileSync(new URL("./ChatsListScreen.tsx", import.meta.url), "utf8");

/** The one Pressable that contains `marker`, from its `<Pressable` to its close tag. */
function pressableAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) return "";
  const open = source.lastIndexOf("<Pressable", at);
  const close = source.indexOf("</Pressable>", at);
  if (open < 0 || close < 0) return "";
  return source.slice(open, close + "</Pressable>".length);
}

const row = pressableAround(screen, "accessibilityLabel={`${title}${item.unread");
const tag = pressableAround(screen, "accessibilityLabel={`Goal ${goal.name}`}");
const start = screen.indexOf("const selectRow");
const selectRow = start < 0 ? "" : screen.slice(start, screen.indexOf("};", start) + 2);

describe("a goal tag on a chat row", () => {
  it("starts row selection on a long press through the row's own handler", () => {
    expect(selectRow).toContain("setSelected(new Set([threadId]))");
    expect(selectRow).toContain("toggle(threadId)");
    expect(row).toContain("onLongPress={() => selectRow(item.link.threadId)}");
    expect(tag).toContain("onLongPress={() => selectRow(item.link.threadId)}");
    expect(tag).toContain("delayLongPress={350}");
  });

  it("does not open the goal sheet from that long press", () => {
    const longPress = tag.slice(tag.indexOf("onLongPress"), tag.indexOf("disabled={selecting}"));
    expect(longPress.length).toBeGreaterThan(0);
    expect(longPress).not.toContain("setGoalId");
  });

  it("still opens the goal sheet on a normal tap", () => {
    expect(tag).toContain("onPress={() => setGoalId(goal.projectId)}");
  });
});
