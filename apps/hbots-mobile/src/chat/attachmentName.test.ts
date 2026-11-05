import { describe, expect, it } from "vite-plus/test";

import { attachmentName } from "./attachmentName";

describe("attachmentName", () => {
  it("uses the name the photo picker returns", () => {
    expect(attachmentName({ fileName: "probe.png", camera: false, index: 0 })).toBe("probe.png");
  });

  it("does not show the picker cache name when it has no real one", () => {
    expect(
      attachmentName({
        fileName: "2aa6f085-3c88-4357-aa84-6526c6061fca.png",
        camera: false,
        index: 2,
      }),
    ).toBe("Photo 3.jpg");
    expect(attachmentName({ fileName: null, camera: false, index: 2 })).toBe("Photo 3.jpg");
    expect(attachmentName({ fileName: null, camera: true, index: 0 })).toBe("Camera photo.jpg");
  });
});
