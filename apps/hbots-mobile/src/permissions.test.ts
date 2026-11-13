import { describe, expect, it } from "vite-plus/test";

import { BLOCKED_PERMISSIONS } from "./permissions";

describe("Android permissions", () => {
  it("lets the microphone through, because voice calls record audio", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.RECORD_AUDIO");
  });

  it("still blocks the storage permissions no feature uses", () => {
    expect(BLOCKED_PERMISSIONS).toContain("android.permission.READ_EXTERNAL_STORAGE");
    expect(BLOCKED_PERMISSIONS).toContain("android.permission.WRITE_EXTERNAL_STORAGE");
  });

  it("lets the overlay permission through, because its grant reopens the app after an update", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.SYSTEM_ALERT_WINDOW");
  });

  it("keeps the permissions the app does use out of the block list", () => {
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.INTERNET");
    expect(BLOCKED_PERMISSIONS).not.toContain("android.permission.CAMERA");
  });
});
