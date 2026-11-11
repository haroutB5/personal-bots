import { describe, expect, it } from "vite-plus/test";

import { BLOCKED_PERMISSIONS } from "./permissions";

describe("Android permissions", () => {
  it("lets the microphone through, because voice calls record audio", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.RECORD_AUDIO");
  });

  it("still blocks the storage and overlay permissions no feature uses", () => {
    expect(BLOCKED_PERMISSIONS).toContain("android.permission.SYSTEM_ALERT_WINDOW");
    expect(BLOCKED_PERMISSIONS).toContain("android.permission.READ_EXTERNAL_STORAGE");
  });

  it("keeps the permissions the app does use out of the block list", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.INTERNET");
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.CAMERA");
  });
});
