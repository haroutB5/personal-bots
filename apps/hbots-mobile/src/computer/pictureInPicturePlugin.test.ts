import { describe, expect, it } from "vite-plus/test";

type Entry = { $: Record<string, string> };
type Manifest = { manifest: { application: Array<{ $: Record<string, string>; activity: Entry[] }> } };

const plugin = require("../../plugins/withPictureInPicture.cjs") as {
  applyPictureInPicture: (manifest: Manifest) => Manifest;
};

function manifest(configChanges?: string): Manifest {
  return {
    manifest: {
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [
            {
              $: {
                "android:name": ".MainActivity",
                ...(configChanges === undefined ? {} : { "android:configChanges": configChanges }),
              },
            },
            { $: { "android:name": "expo.modules.hbotsshare.ShareActivity" } },
          ],
        },
      ],
    },
  };
}

describe("the picture-in-picture manifest entry", () => {
  it("turns PiP on for the main activity", () => {
    const [main] = plugin.applyPictureInPicture(manifest()).manifest.application[0]!.activity;
    expect(main!.$["android:supportsPictureInPicture"]).toBe("true");
  });

  it("leaves every other activity alone", () => {
    const [, share] = plugin.applyPictureInPicture(manifest()).manifest.application[0]!.activity;
    expect(share!.$["android:supportsPictureInPicture"]).toBeUndefined();
  });

  it("keeps the existing config changes and adds the missing ones once", () => {
    const run = plugin.applyPictureInPicture(
      manifest("keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode"),
    );
    const flags = run.manifest.application[0]!.activity[0]!.$["android:configChanges"]!.split("|");
    expect(flags).toContain("uiMode");
    expect(flags).toContain("smallestScreenSize");
    expect(flags.filter((flag) => flag === "orientation")).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = plugin.applyPictureInPicture(manifest());
    const twice = plugin.applyPictureInPicture(JSON.parse(JSON.stringify(once)) as Manifest);
    expect(twice).toEqual(once);
  });

  it("throws when the main activity is missing", () => {
    const empty = manifest();
    empty.manifest.application[0]!.activity = [];
    expect(() => plugin.applyPictureInPicture(empty)).toThrow(/MainActivity/);
  });
});
