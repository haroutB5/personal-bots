import { describe, expect, it } from "vite-plus/test";

import { resolveBrowserNavigationTarget, resolveBrowserUrl } from "./urlPolicy.ts";

describe("personal browser URL policy", () => {
  it.each([
    "javascript:alert(1)",
    "file:///C:/Windows/win.ini",
    "data:text/html,<script>alert(1)</script>",
    "chrome://settings",
    "about:blank",
    "ftp://example.com/file",
    "",
  ])("rejects %j", (raw) => {
    expect(resolveBrowserUrl(raw).ok).toBe(false);
  });

  it("normalizes schemeless hosts like the preview browser", () => {
    expect(resolveBrowserUrl("example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(resolveBrowserUrl("localhost:5173/app")).toEqual({
      ok: true,
      url: "http://localhost:5173/app",
    });
    expect(resolveBrowserUrl("HTTP://Example.com/a?b=1")).toEqual({
      ok: true,
      url: "http://example.com/a?b=1",
    });
  });

  it("resolves environment ports against this machine only", () => {
    expect(
      resolveBrowserNavigationTarget({ kind: "environment-port", port: 5173, path: "settings" }),
    ).toEqual({ ok: true, url: "http://localhost:5173/settings" });
    expect(resolveBrowserNavigationTarget({ kind: "url", url: "javascript:void 0" }).ok).toBe(
      false,
    );
  });
});
