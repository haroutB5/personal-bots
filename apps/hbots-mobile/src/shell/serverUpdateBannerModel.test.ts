import { describe, expect, it } from "vite-plus/test";

import { finishedNoteForApp } from "./serverUpdateBannerModel";

const note = { title: "Updated to 1.67.18", detail: null, tone: "plain" as const };

describe("finishedNoteForApp", () => {
  it("says the server moved and the app update follows when the updater has a newer target", () => {
    expect(
      finishedNoteForApp(note, {
        finished: true,
        serverVersion: "1.67.18",
        appVersion: "1.67.17",
        appUpdateVersion: "1.67.18",
      }),
    ).toEqual({
      title: "Server updated to 1.67.18",
      detail: "This app is on 1.67.17. Its update follows.",
      tone: "plain",
    });
  });

  it("promises no app update after a server-only release or before the APK is published", () => {
    for (const appUpdateVersion of [undefined, null, "1.67.17"])
      expect(
        finishedNoteForApp(note, {
          finished: true,
          serverVersion: "1.67.18",
          appVersion: "1.67.17",
          appUpdateVersion,
        }),
      ).toEqual({
        title: "Server updated to 1.67.18",
        detail: "This app is on 1.67.17.",
        tone: "plain",
      });
  });

  it("keeps the short note when the app already matches", () => {
    expect(
      finishedNoteForApp(note, { finished: true, serverVersion: "1.67.18", appVersion: "1.67.18" }),
    ).toBe(note);
  });

  it("leaves other stages and unknown versions alone", () => {
    const stage = { title: "Checking update 1.67.18", detail: null, tone: "plain" as const };
    expect(
      finishedNoteForApp(stage, {
        finished: false,
        serverVersion: "1.67.18",
        appVersion: "1.67.17",
      }),
    ).toBe(stage);
    expect(
      finishedNoteForApp(note, { finished: true, serverVersion: null, appVersion: "1.67.17" }),
    ).toBe(note);
    expect(
      finishedNoteForApp(note, { finished: true, serverVersion: "1.67.18", appVersion: "" }),
    ).toBe(note);
  });
});
