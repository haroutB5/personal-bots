import { describe, expect, it } from "vite-plus/test";

import { finishedNoteForApp } from "./serverUpdateBannerModel";

const note = { title: "Updated to 1.67.18", detail: null, tone: "plain" as const };

describe("finishedNoteForApp", () => {
  it("says the server moved when the app is still on an older version", () => {
    expect(
      finishedNoteForApp(note, { finished: true, serverVersion: "1.67.18", appVersion: "1.67.17" }),
    ).toEqual({
      title: "Server updated to 1.67.18",
      detail: "This app is on 1.67.17. Its update follows.",
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
