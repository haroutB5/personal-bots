import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const composer = NodeFS.readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");

describe("a camera draft copy leaves with its draft", () => {
  it("is released once the sent message's server copy has drawn", () => {
    expect(composer).toMatch(
      /localImages\.landed\(messageId, \(\) => \{[\s\S]*?releaseDraftCopies\(snapshot\)/,
    );
  });

  it("is deleted when the photo is removed from the draft", () => {
    expect(composer).toMatch(/discardCameraDraft\(attachment\.uri\);\s*\n\s*setDraft\(/);
  });
});
