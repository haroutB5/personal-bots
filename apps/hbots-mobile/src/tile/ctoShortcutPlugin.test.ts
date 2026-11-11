import { describe, expect, it } from "vite-plus/test";

import { newChatLink } from "./ctoTarget";

const plugin = require("../../plugins/withCtoShortcut.cjs") as {
  shortcutsXml: (packageName: string) => string;
  applyShortcutMeta: (manifest: unknown) => {
    manifest: { application: Array<{ activity: Array<Record<string, unknown>> }> };
  };
  SHORTCUT_LINK: string;
};

describe("the CTO launcher shortcut", () => {
  it("opens the same alias link the tile falls back to", () => {
    expect(plugin.SHORTCUT_LINK).toBe(newChatLink());
  });

  it("targets the app's main activity with a view intent", () => {
    const xml = plugin.shortcutsXml("com.haroutb5.hbots");
    expect(xml).toContain('android:data="hbots://bot/cto?new=1"');
    expect(xml).toContain('android:targetClass="com.haroutb5.hbots.MainActivity"');
    expect(xml).toContain('android:targetPackage="com.haroutb5.hbots"');
    expect(xml).toContain("android.intent.action.VIEW");
  });
});
