import { describe, expect, it } from "vite-plus/test";

type Entry = { $: Record<string, string>; "intent-filter": Array<Record<string, any>> };
type Manifest = {
  manifest: { application: Array<{ $: Record<string, string>; activity: Entry[] }> };
};

const plugin = require("../../plugins/withShareTarget.cjs") as {
  applyShareTarget: (manifest: Manifest) => Manifest;
  ACTIVITY_NAME: string;
};

function manifest(): Manifest {
  return {
    manifest: {
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" }, "intent-filter": [] }],
        },
      ],
    },
  };
}

function shareEntry(m: Manifest): Entry {
  const found = m.manifest.application[0]!.activity.find(
    (entry) => entry.$["android:name"] === plugin.ACTIVITY_NAME,
  );
  if (found === undefined) throw new Error("ShareActivity missing");
  return found;
}

describe("the share target manifest entry", () => {
  it("is a task-less, recents-less, exported activity", () => {
    const attrs = shareEntry(plugin.applyShareTarget(manifest())).$;
    expect(attrs["android:taskAffinity"]).toBe("");
    expect(attrs["android:excludeFromRecents"]).toBe("true");
    expect(attrs["android:exported"]).toBe("true");
    expect(attrs["android:noHistory"]).toBe("true");
  });

  it("takes SEND and SEND_MULTIPLE for text, images and PDFs", () => {
    const filters = shareEntry(plugin.applyShareTarget(manifest()))["intent-filter"];
    for (const action of ["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"]) {
      const filter = filters.find((f) => f.action[0].$["android:name"] === action);
      expect(filter?.data.map((d: any) => d.$["android:mimeType"])).toEqual([
        "text/*",
        "image/*",
        "application/pdf",
      ]);
    }
  });

  it("takes PROCESS_TEXT as Ask hbots", () => {
    const filters = shareEntry(plugin.applyShareTarget(manifest()))["intent-filter"];
    const ask = filters.find(
      (f) => f.action[0].$["android:name"] === "android.intent.action.PROCESS_TEXT",
    );
    expect(ask?.$["android:label"]).toBe("@string/hbots_ask_label");
    expect(ask?.data[0].$["android:mimeType"]).toBe("text/plain");
  });

  it("is added once", () => {
    const once = plugin.applyShareTarget(manifest());
    plugin.applyShareTarget(once);
    expect(once.manifest.application[0]!.activity).toHaveLength(2);
  });
});
