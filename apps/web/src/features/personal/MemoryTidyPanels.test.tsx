import type { PersonalMemoryTidyChange } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TidyChangeItem } from "./MemoryTidyPanels";
import { UNLISTED_MEMORY_TEXT } from "./memoryPresentation";

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("./usePersonalAutomation", () => ({
  personalMemoryRestore: {},
  personalMemoryTidyDecide: {},
  personalMemoryTidyRun: {},
  personalMemoryTidySetMode: {},
  usePersonalMemoryTidyLog: () => ({ data: null, error: null }),
}));

const change = (overrides: Partial<Record<string, unknown>>): PersonalMemoryTidyChange =>
  ({
    changeId: 1,
    status: "applied",
    action: "supersede",
    scope: "shared",
    scopeId: null,
    memoryIds: ["m-old"],
    resultMemoryId: "m-new",
    content: null,
    changeHash: "h",
    reason: "",
    ...overrides,
  }) as unknown as PersonalMemoryTidyChange;

const texts = new Map([
  ["m-old", "Lives in Leeds"],
  ["m-new", "Lives in York now"],
  ["m-long", "Likes tea. Works on the dev team."],
]);

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const textOf = (item: PersonalMemoryTidyChange): string => {
  act(() => {
    renderer = create(<TidyChangeItem change={item} texts={texts} botName={() => undefined} />);
  });
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer!.toJSON());
  return parts.join("|");
};

describe("TidyChangeItem", () => {
  it("shows what a supersede archives and the newer entry it keeps", () => {
    const shown = textOf(change({ content: "Lives in York" }));
    expect(shown).toContain("Archives|Lives in Leeds");
    expect(shown).toContain("Keeps (newer)|Lives in York");
    expect(shown).not.toContain("Lives in York now");
  });

  it("falls back to the listed text, then a plain line, for the kept entry", () => {
    expect(textOf(change({}))).toContain("Keeps (newer)|Lives in York now");
    act(() => renderer?.unmount());
    expect(textOf(change({ resultMemoryId: "m-gone" }))).toContain(
      `Keeps (newer)|${UNLISTED_MEMORY_TEXT}`,
    );
  });

  it("shows a retirement as just the archived list", () => {
    const shown = textOf(change({ resultMemoryId: null }));
    expect(shown).toContain("Archives|Lives in Leeds");
    expect(shown).not.toContain("Keeps (newer)");
  });

  it("shows a split's entry and each part with its kind and reach", () => {
    const shown = textOf(
      change({
        action: "split",
        status: "pending",
        memoryIds: ["m-long"],
        resultMemoryId: null,
        parts: [
          { content: "Likes tea.", kind: "preference", scope: "shared", scopeId: null },
          { content: "Works on the dev team.", kind: "note", scope: "team", scopeId: "dev" },
        ],
      }),
    );
    expect(shown).toContain("Split|");
    expect(shown).toContain("Archives|Likes tea. Works on the dev team.");
    expect(shown).toContain("Split into (2)");
    expect(shown).toContain("Likes tea.|Preference · All bots");
    expect(shown).toContain("Works on the dev team.|Note · Dev team");
  });
});

describe("TidyChangeItem: what an approval is bound to", () => {
  it("tags each archived entry with the kind and reach it is bound to, and the kept one as text only", () => {
    const text = textOf(
      change({
        status: "pending",
        bound: [
          { memoryId: "m-old", kind: "preference", scope: "team", scopeId: "dev", textOnly: false },
          { memoryId: "m-new", kind: "preference", scope: "shared", scopeId: null, textOnly: true },
        ],
      }),
    );
    expect(text).toContain("Bound to: Preference · Dev team");
    expect(text).toContain("Bound to its text");
  });

  it("shows no bound tags for an older change without snapshots", () => {
    expect(textOf(change({ status: "pending" }))).not.toContain("Bound to");
  });
});
