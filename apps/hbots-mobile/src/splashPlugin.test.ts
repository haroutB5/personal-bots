import { describe, expect, it } from "vite-plus/test";

import config from "../app.config";

type Xml = { resources: Record<string, Array<{ $: { name: string }; _?: string }>> };

const plugin = require("../plugins/withDarkSplash.cjs") as {
  applySplashColor: (colors: Xml, hex: string) => Xml;
  applySplashTheme: (styles: Xml) => Xml;
  SPLASH_COLOR: string;
  SPLASH_THEME: string;
};

// The template's launch styles: a bitmap window background that is white.
function templateStyles() {
  return {
    resources: {
      style: [
        { $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" }, item: [] },
        {
          $: { name: "Theme.App.SplashScreen", parent: "AppTheme" },
          item: [{ $: { name: "android:windowBackground" }, _: "@drawable/splashscreen_logo" }],
        },
      ],
    },
  } as unknown as Xml;
}

function items(xml: Xml, theme: string) {
  const style = xml.resources.style?.find((entry) => entry.$.name === theme) as unknown as {
    item: Array<{ $: { name: string }; _: string }>;
  };
  return Object.fromEntries(style.item.map((entry) => [entry.$.name, entry._]));
}

describe("the dark splash", () => {
  it("is part of the app config", () => {
    expect(config.plugins).toContain("./plugins/withDarkSplash.cjs");
  });

  it("replaces the template's white splash colour with the app background", () => {
    const colors = {
      resources: { color: [{ $: { name: "splashscreen_background" }, _: "#FFFFFF" }] },
    } as unknown as Xml;
    const result = plugin.applySplashColor(colors, config.backgroundColor as string);
    expect(result.resources.color).toEqual([{ $: { name: "splashscreen_background" }, _: "#0f0f0e" }]);
  });

  it("adds the colour to a colours file that is empty", () => {
    const result = plugin.applySplashColor({ resources: "" } as unknown as Xml, "#0f0f0e");
    expect(result.resources.color).toEqual([{ $: { name: "splashscreen_background" }, _: "#0f0f0e" }]);
  });

  it("points the launch theme at the colour for Android 8 to 11 and for 12 and later", () => {
    const result = plugin.applySplashTheme(templateStyles());
    expect(items(result, plugin.SPLASH_THEME)).toEqual({
      "android:windowBackground": "@color/splashscreen_background",
      "android:windowSplashScreenBackground": "@color/splashscreen_background",
    });
  });

  it("is safe to apply twice", () => {
    const once = plugin.applySplashTheme(templateStyles());
    const twice = plugin.applySplashTheme(once);
    expect(Object.keys(items(twice, plugin.SPLASH_THEME))).toHaveLength(2);
  });

  it("keeps the window before React mounts dark through the same background colour", () => {
    expect(config.backgroundColor).toBe("#0f0f0e");
    expect(config.plugins).toContain("expo-system-ui");
  });
});
