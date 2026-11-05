import { describe, expect, it } from "vite-plus/test";

import { attachmentName } from "./attachmentName";

describe("attachmentName", () => {
  it("prefers the display name the content resolver read", () => {
    expect(
      attachmentName({
        resolvedName: "R2 F3 photo.png",
        fileName: "22.png",
        camera: false,
        index: 0,
      }),
    ).toBe("R2 F3 photo.png");
  });

  it("falls back to the picker name, then to a numbered photo", () => {
    expect(
      attachmentName({ resolvedName: null, fileName: "probe.png", camera: false, index: 2 }),
    ).toBe("probe.png");
    expect(attachmentName({ resolvedName: null, fileName: null, camera: false, index: 2 })).toBe(
      "Photo 3.jpg",
    );
    expect(attachmentName({ resolvedName: null, fileName: null, camera: true, index: 0 })).toBe(
      "Camera photo.jpg",
    );
  });
});
