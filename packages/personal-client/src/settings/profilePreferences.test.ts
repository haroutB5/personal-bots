import { describe, expect, it } from "@effect/vitest";

import {
  planSharedPreferenceImport,
  sharedPreferencesFromProfile,
  type StoredSharedPreferences,
} from "./profilePreferences.ts";

const legacyFrom = (values: Readonly<Record<string, string>>) => (key: string) =>
  values[key] ?? null;

describe("shared preferences from the profile", () => {
  it("reads the defaults when the server has no value or no profile", () => {
    const defaults = { showToolSteps: false, showRoutinesStrip: true };
    expect(sharedPreferencesFromProfile(null)).toEqual(defaults);
    expect(sharedPreferencesFromProfile(undefined)).toEqual(defaults);
    expect(sharedPreferencesFromProfile({})).toEqual(defaults);
  });

  it("reads a stored value over the default", () => {
    expect(sharedPreferencesFromProfile({ showToolSteps: true, showRoutinesStrip: false })).toEqual(
      { showToolSteps: true, showRoutinesStrip: false },
    );
    expect(sharedPreferencesFromProfile({ showToolSteps: true })).toEqual({
      showToolSteps: true,
      showRoutinesStrip: true,
    });
  });
});

describe("one-time import of the browser values", () => {
  const readLegacy = legacyFrom({
    "personal-show-tool-steps": "1",
    "personal-show-routines-strip": "0",
  });

  it("imports what the server is missing and clears the browser keys", () => {
    expect(planSharedPreferenceImport({}, readLegacy)).toEqual({
      values: { showToolSteps: true, showRoutinesStrip: false },
      clearLegacyKeys: ["personal-show-tool-steps", "personal-show-routines-strip"],
    });
  });

  it("imports only the field the server is missing", () => {
    expect(planSharedPreferenceImport({ showToolSteps: false }, readLegacy)).toEqual({
      values: { showRoutinesStrip: false },
      clearLegacyKeys: ["personal-show-tool-steps", "personal-show-routines-strip"],
    });
  });

  it("never overwrites a value the server already has", () => {
    const profile: StoredSharedPreferences = { showToolSteps: false, showRoutinesStrip: true };
    expect(planSharedPreferenceImport(profile, readLegacy)).toEqual({
      values: {},
      clearLegacyKeys: ["personal-show-tool-steps", "personal-show-routines-strip"],
    });
  });

  it("does not import twice, even when the browser keys are still there", () => {
    const first = planSharedPreferenceImport({}, readLegacy);
    const saved: StoredSharedPreferences = first.values;
    // The keys stay behind on the first pass (the write has not answered yet).
    const second = planSharedPreferenceImport(saved, readLegacy);
    expect(second.values).toEqual({});
    expect(second.clearLegacyKeys).toEqual([
      "personal-show-tool-steps",
      "personal-show-routines-strip",
    ]);
  });

  it("writes nothing when the browser has no value of its own", () => {
    expect(planSharedPreferenceImport({}, legacyFrom({}))).toEqual({
      values: {},
      clearLegacyKeys: [],
    });
  });

  it("keeps the browser values when no profile could be read", () => {
    expect(planSharedPreferenceImport(null, readLegacy)).toEqual({
      values: {},
      clearLegacyKeys: [],
    });
  });

  it("ignores a browser value it cannot read", () => {
    expect(
      planSharedPreferenceImport(
        {},
        legacyFrom({ "personal-show-tool-steps": "yes", "personal-show-routines-strip": "0" }),
      ),
    ).toEqual({
      values: { showRoutinesStrip: false },
      clearLegacyKeys: ["personal-show-tool-steps", "personal-show-routines-strip"],
    });
  });
});
