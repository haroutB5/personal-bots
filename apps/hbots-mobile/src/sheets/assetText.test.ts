import { describe, expect, it } from "vite-plus/test";

import { readAssetText, type TextFetcher } from "./assetText";

const SIGNED_URL = "https://laptop.test/api/assets/abc.def/RESULT.md";

describe("readAssetText", () => {
  it("fetches the signed URL without letting the polyfill rewrite it", async () => {
    const seen: string[] = [];
    const doFetch: TextFetcher = (url, init) => {
      seen.push(url);
      const rewritten = init?.cache === "no-store" || init?.cache === "no-cache";
      return Promise.resolve({
        ok: !rewritten,
        text: () => Promise.resolve("file body"),
      });
    };

    await expect(readAssetText(SIGNED_URL, doFetch)).resolves.toBe("file body");
    expect(seen).toEqual([SIGNED_URL]);
  });

  it("reports a refused read", async () => {
    const doFetch: TextFetcher = () =>
      Promise.resolve({ ok: false, text: () => Promise.resolve("") });
    await expect(readAssetText(SIGNED_URL, doFetch)).rejects.toThrow("Couldn't read that file.");
  });
});
