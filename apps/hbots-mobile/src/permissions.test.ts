import { describe, expect, it } from "vite-plus/test";

import { BLOCKED_PERMISSIONS } from "./permissions";

describe("Android permissions", () => {
  it("blocks the microphone, because no chat feature records audio", () => {
    expect(BLOCKED_PERMISSIONS).toContain("android.permission.RECORD_AUDIO");
  });

  it("keeps the permissions the app does use out of the block list", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.INTERNET");
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.CAMERA");
  });
});
