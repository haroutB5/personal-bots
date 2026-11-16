import { describe, expect, it } from "vite-plus/test";
import { addPhotosLabel, attachPhotos, cameraRefusal, libraryPick } from "./attachSheetModel";

describe("attachPhotos", () => {
  it("embeds the picker with the room left as its limit", () => {
    expect(attachPhotos({ embedded: true, attached: 3, maxAttachments: 10 })).toEqual({
      kind: "embedded",
      maxSelection: 7,
    });
  });

  it("lets a draft with one place left pick one photo", () => {
    expect(attachPhotos({ embedded: true, attached: 9, maxAttachments: 10 })).toEqual({
      kind: "embedded",
      maxSelection: 1,
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

describe("addPhotosLabel", () => {
  it("is a disabled Add with nothing selected", () => {
    expect(addPhotosLabel(0)).toEqual({ label: "Add", enabled: false });
  });

  it("counts one photo in the singular", () => {
    expect(addPhotosLabel(1)).toEqual({ label: "Add 1 photo", enabled: true });
  });

  it("counts several photos in the plural", () => {
    expect(addPhotosLabel(3)).toEqual({ label: "Add 3 photos", enabled: true });
  });
});

describe("libraryPick", () => {
  it("picks one photo when one place is left", () => {
    expect(libraryPick(1)).toEqual({ allowsMultipleSelection: false, selectionLimit: 1 });
  });

  it("limits a multiple pick to the room left", () => {
    expect(libraryPick(4)).toEqual({ allowsMultipleSelection: true, selectionLimit: 4 });
  });

  it("never asks for less than one", () => {
    expect(libraryPick(0)).toEqual({ allowsMultipleSelection: false, selectionLimit: 1 });
  });
});
