import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  pageAssetResource,
  pageFrameHeight,
  pageLinkToOpen,
  pageUrlWithTheme,
} from "./pageFrameModel";

const reference = {
  attachmentId: "thread-1-abc-html",
  title: "hbots widget mockups",
  height: 640,
  heights: [
    [320, 1400],
    [375, 1200],
    [728, 640],
  ] as ReadonlyArray<readonly [number, number]>,
};

describe("page frame model", () => {
  it("asks for the page as inline html, as the web chat does", () => {
    expect(pageAssetResource(reference)).toEqual({
      _tag: "attachment",
      attachmentId: "thread-1-abc-html",
      fileName: "hbots widget mockups.html",
      mimeType: "text/html",
      disposition: "inline",
    });
  });

  it("sizes the frame from the height measured for the chat's width", () => {
    expect(pageFrameHeight({ ...reference, height: 2000 }, 336, null)).toBe(1400);
    expect(pageFrameHeight({ attachmentId: "a-html", title: "x", height: 300 }, 336, null)).toBe(
      300,
    );
  });

  it("lets the page's own height grow the frame, never shrink it", () => {
    expect(pageFrameHeight({ ...reference, height: 2000 }, 336, 1650)).toBe(1650);
    expect(pageFrameHeight({ ...reference, height: 2000 }, 336, 200)).toBe(1400);
    expect(pageFrameHeight({ ...reference, height: 2000 }, 336, Number.NaN)).toBe(1400);
  });

  it("puts the dark theme on the link and drops any earlier fragment", () => {
    const url = pageUrlWithTheme("https://bots.example/a/Page.html?sig=1#old");
    expect(url.startsWith("https://bots.example/a/Page.html?sig=1#t3-theme=")).toBe(true);
    expect(url).not.toContain("#old");
  });

  it("opens only web addresses outside the app", () => {
    expect(pageLinkToOpen("https://example.com/a")).toBe("https://example.com/a");
    expect(pageLinkToOpen("http://example.com")).toBe("http://example.com");
    for (const url of ["intent://x", "file:///x", "javascript:alert(1)", "hbots://pair", "", 4]) {
      expect(pageLinkToOpen(url)).toBeNull();
    }
  });
});

const kotlin = NodeFS.readFileSync(
  NodeURL.fileURLToPath(
    new URL(
      "../../modules/hbots-pageview/android/src/main/java/expo/modules/hbotspageview/HbotsPageView.kt",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("page view sandbox", () => {
  it("never gives the page a bridge into the app", () => {
    expect(kotlin).not.toContain("addJavascriptInterface");
    expect(kotlin).not.toContain("evaluateJavascript");
    expect(kotlin).not.toContain("WebMessage");
  });

  it("keeps files, storage, windows and permissions off", () => {
    for (const setting of [
      "allowFileAccess = false",
      "allowContentAccess = false",
      "allowFileAccessFromFileURLs = false",
      "allowUniversalAccessFromFileURLs = false",
      "domStorageEnabled = false",
      "databaseEnabled = false",
      "saveFormData = false",
      "setGeolocationEnabled(false)",
      "setSupportMultipleWindows(false)",
      "javaScriptCanOpenWindowsAutomatically = false",
      "mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW",
      "setAcceptThirdPartyCookies(view, false)",
      "request.deny()",
      "handler.cancel()",
    ]) {
      expect(kotlin, setting).toContain(setting);
    }
  });

  it("routes every navigation and request through the policy", () => {
    expect(kotlin).toContain(
      "PageNavigationPolicy.decide(pageUrl, target, request.isForMainFrame)",
    );
    expect(kotlin).toContain("PageNavigationPolicy.allowsSubresource(pageUrl,");
    expect(kotlin).toContain("request.hasGesture()");
    expect(kotlin.match(/\.loadUrl\(/gu)).toHaveLength(2);
  });
});
