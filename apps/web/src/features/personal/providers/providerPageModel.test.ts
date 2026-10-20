import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderRow } from "../providerRows";
import {
  answeredLine,
  pageNote,
  reasonOf,
  setupFinished,
  setupSteps,
  stateWord,
  testLine,
} from "./providerPageModel";

const input = {
  installed: false,
  installFailed: false,
  authNeeded: false,
  canTest: true,
  testPassed: false,
  testFailed: false,
  installedVersion: null,
  signInNote: "Google account",
};

describe("setupSteps (SPEC 5.3)", () => {
  it("the first open step is now, the rest next", () => {
    expect(setupSteps(input).map((step) => step.status)).toEqual(["now", "next", "next"]);
    expect(
      setupSteps({ ...input, installed: true, authNeeded: true, installedVersion: "1.4.1" }).map(
        (step) => [step.key, step.status, step.note],
      ),
    ).toEqual([
      ["install", "done", "1.4.1"],
      ["signIn", "now", "Google account"],
      ["test", "next", null],
    ]);
    expect(setupSteps({ ...input, installed: true }).map((step) => step.status)).toEqual([
      "done",
      "done",
      "now",
    ]);
  });

  it("marks a failed install or test where it happened, and finishes only when all are done", () => {
    expect(setupSteps({ ...input, installFailed: true })[0]?.status).toBe("failed");
    expect(setupSteps({ ...input, installed: true, testFailed: true })[2]?.status).toBe("failed");
    const done = setupSteps({ ...input, installed: true, testPassed: true });
    expect(setupFinished(done)).toBe(true);
    expect(setupFinished(setupSteps(input))).toBe(false);
  });

  it("a provider with no test message of its own has two steps", () => {
    const steps = setupSteps({ ...input, canTest: false, installed: true });
    expect(steps.map((step) => step.key)).toEqual(["install", "signIn"]);
    expect(setupFinished(steps)).toBe(true);
  });
});

const row = (overrides: Partial<ProviderRow>): ProviderRow => ({
  instanceId: "opencode",
  driver: "opencode" as ProviderRow["driver"],
  label: "OpenCode",
  state: "ready",
  dot: "live",
  statusText: "x",
  tone: "normal",
  detail: null,
  action: null,
  progress: null,
  busy: false,
  bots: [],
  ...overrides,
});

const snapshot = (smokeCheck: unknown) => ({ smokeCheck, models: [] }) as unknown as ServerProvider;

describe("stateWord", () => {
  it("names the state in one bold word", () => {
    expect(stateWord(row({ state: "ready" }))).toBe("Ready");
    expect(stateWord(row({ state: "needsSignIn" }))).toBe("Needs sign-in");
    expect(stateWord(row({ state: "updateAvailable" }))).toBe("Update available");
    expect(stateWord(row({ state: "off" }))).toBe("Off");
  });
});

describe("pageNote (SPEC 7: one sentence of what happened, one next step)", () => {
  it("update broke: the version, the provider's own first line, and Go back when possible", () => {
    const note = pageNote(
      row({ state: "updateBroke", action: { kind: "goBack", label: "Go back" } }),
      snapshot({
        status: "failed",
        version: "1.19.3",
        message: "opencode/x: Unexpected server error\nstack line",
        previousVersion: "1.19.2",
      }),
      false,
    );
    expect(note).toEqual({
      tone: "review",
      title: "An update broke OpenCode",
      text: '1.19.3 failed the test message with "Unexpected server error". 1.19.2 passed before.',
      buttons: ["goBack", "testAgain"],
    });
    expect(
      pageNote(
        row({ state: "updateBroke", action: { kind: "testAgain", label: "Test again" } }),
        snapshot({ status: "failed", version: "1", message: null }),
        false,
      )?.buttons,
    ).toEqual(["testAgain"]);
  });

  it("model gone names the bots and offers a new model", () => {
    const note = pageNote(
      row({ state: "modelGone", bots: ["Watcher", "Musey"] }),
      snapshot({ status: "passed", version: "1", missingModels: ["Muse Spark 1.3"] }),
      false,
    );
    expect(note).toMatchObject({
      title: "Muse Spark 1.3 is gone",
      text: "OpenCode no longer offers it. Watcher and Musey use it and can't reply until they get another model.",
      buttons: ["pickModel"],
    });
  });

  it("won't start offers Remove it only where the app owns the install", () => {
    const wontStart = row({ state: "wontStart", detail: "unsupported platform" });
    expect(pageNote(wontStart, snapshot(undefined), true)).toMatchObject({
      title: "Installed, but it won't start",
      text: 'OpenCode stopped with "unsupported platform".',
      buttons: ["tryAgain", "removeIt"],
    });
    expect(pageNote(wontStart, snapshot(undefined), false)?.buttons).toEqual(["tryAgain"]);
  });

  it("a plain ready provider has no note", () => {
    expect(pageNote(row({}), snapshot(undefined), false)).toBeNull();
  });
});

describe("reasonOf, testLine, answeredLine", () => {
  it("cuts the model prefix and keeps one line", () => {
    expect(reasonOf("claude-opus-5: API Error: 500\nmore")).toBe("API Error: 500");
    expect(reasonOf("plain message")).toBe("plain message");
    expect(reasonOf(null)).toBeNull();
  });

  it("says when the last test ran and how long it took", () => {
    const now = new Date("2026-10-20T22:00:00");
    const passed = {
      status: "passed",
      version: "1",
      checkedAt: new Date("2026-10-20T21:58:00").toISOString(),
      message: null,
      durationMs: 2400,
    } as NonNullable<ServerProvider["smokeCheck"]>;
    expect(testLine(passed, now)).toBe("Passed today 21:58 · 2.4 s");
    expect(testLine({ ...passed, status: "failed" }, now)).toBe("Failed today 21:58");
    expect(testLine({ ...passed, status: "checking" }, now)).toBe("Testing…");
    expect(testLine(undefined, now)).toBeNull();
  });

  it("names the model that answered", () => {
    const smoke = {
      status: "passed",
      version: "1",
      checkedAt: null,
      message: null,
      model: "g3",
      durationMs: 2400,
    } as NonNullable<ServerProvider["smokeCheck"]>;
    expect(
      answeredLine(smoke, [
        { slug: "g3", name: "Gemini 3 Pro" },
      ] as unknown as ServerProvider["models"]),
    ).toBe("Gemini 3 Pro answered in 2.4 s");
  });
});
