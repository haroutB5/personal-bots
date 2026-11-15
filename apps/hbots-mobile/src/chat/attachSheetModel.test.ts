import { describe, expect, it } from "vite-plus/test";
import { attachPhotos, cameraRefusal } from "./attachSheetModel";

describe("attachPhotos", () => {
  it("embeds the picker while the draft has room", () => {
    expect(attachPhotos({ embedded: true, attached: 3, maxAttachments: 10 })).toEqual({
      kind: "embedded",
    });
  });

  it("offers All photos when the phone has no embedded picker", () => {
    expect(attachPhotos({ embedded: false, attached: 0, maxAttachments: 10 })).toEqual({
      kind: "all-photos",
    });
  });

  it("offers nothing to pick when the draft is full", () => {
    expect(attachPhotos({ embedded: true, attached: 10, maxAttachments: 10 })).toEqual({
      kind: "full",
      message: "This message already has 10 attachments. Remove one to add another.",
    });
  });
});

describe("cameraRefusal", () => {
  it("lets a granted camera through", () => {
    expect(cameraRefusal({ granted: true, canAskAgain: true })).toBeNull();
  });

  it("says the camera is off and asks again next time", () => {
    expect(cameraRefusal({ granted: false, canAskAgain: true })).toEqual({
      message: "Camera access is off for hbots.",
      openSettings: false,
    });
  });

  it("points to Settings once Android stops asking", () => {
    expect(cameraRefusal({ granted: false, canAskAgain: false })).toEqual({
      message: "Camera access is off for hbots.",
      openSettings: true,
    });
  });
});
