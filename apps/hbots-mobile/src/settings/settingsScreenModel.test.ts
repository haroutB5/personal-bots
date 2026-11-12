import type { PersonalProfile, PersonalPushDevice } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  autoArchiveEnabled,
  autoArchiveFieldValue,
  autoArchiveHint,
  autoArchiveMinutes,
  notificationDeviceDetail,
  notificationDevicesLine,
  parseAutoArchiveDraft,
  SETTINGS_SECTIONS,
  settingsRowMatches,
  sharedPreferencesOf,
  visibleSettingsSections,
} from "./settingsScreenModel";
import { notificationEventRows } from "./notificationsScreenModel";

const profile = (fields: Partial<PersonalProfile>): PersonalProfile =>
  ({ displayName: "Harout", ...fields }) as PersonalProfile;

describe("settings search", () => {
  it("keeps every row for an empty query", () => {
    expect(settingsRowMatches({ title: "Memory" }, "  ")).toBe(true);
  });

  it("matches the title and the hint, case-insensitively", () => {
    expect(settingsRowMatches({ title: "Memory", hint: "What bots remember" }, "REMEMBER")).toBe(
      true,
    );
    expect(settingsRowMatches({ title: "Memory" }, "providers")).toBe(false);
  });
});

describe("settings registry", () => {
  it("gives every row a unique id", () => {
    const rows = SETTINGS_SECTIONS.flatMap((section) => section.rows);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("gives every row a unique title", () => {
    const rows = SETTINGS_SECTIONS.flatMap((section) => section.rows);
    expect(new Set(rows.map((row) => row.title)).size).toBe(rows.length);
  });

  it("finds memory in exactly one row and one section", () => {
    const visible = visibleSettingsSections("memory");
    expect(visible.map((entry) => entry.section.id)).toEqual(["bots"]);
    expect(visible.flatMap((entry) => entry.rows.map((row) => row.title))).toEqual(["Memory"]);
  });

  it("hides a section whose only row is hidden", () => {
    expect(visibleSettingsSections("restore", new Set(["bots.removed"]))).toEqual([]);
  });
});

describe("auto-archive", () => {
  it("is on and 48h until the profile says otherwise", () => {
    expect(autoArchiveEnabled(null)).toBe(true);
    expect(autoArchiveMinutes(null)).toBe(2880);
    expect(autoArchiveFieldValue(autoArchiveMinutes(null))).toBe("48h");
  });

  it("reads a stored choice and falls back when it is out of range", () => {
    expect(autoArchiveMinutes(profile({ autoArchiveTaskChatsAfterMinutes: 90 }))).toBe(90);
    expect(autoArchiveMinutes(profile({ autoArchiveTaskChatsAfterMinutes: 1 }))).toBe(2880);
    expect(autoArchiveHint(90)).toBe(
      "Finished task and routine-run chats archive after 90 minutes unused. Nothing is deleted.",
    );
  });

  it("parses m and h and refuses junk or out-of-range values", () => {
    expect(parseAutoArchiveDraft("30m")).toEqual({ kind: "valid", minutes: 30 });
    expect(parseAutoArchiveDraft("2h")).toEqual({ kind: "valid", minutes: 120 });
    expect(parseAutoArchiveDraft("soon").kind).toBe("invalid");
    expect(parseAutoArchiveDraft("1m").kind).toBe("invalid");
  });
});

describe("shared preferences", () => {
  it("uses the server value and the agreed defaults", () => {
    expect(sharedPreferencesOf(null)).toEqual({ showToolSteps: false, showRoutinesStrip: true });
    expect(sharedPreferencesOf(profile({ showToolSteps: true, showRoutinesStrip: false }))).toEqual(
      {
        showToolSteps: true,
        showRoutinesStrip: false,
      },
    );
  });
});

describe("notifications", () => {
  it("lists all five events, on when the server has no answer", () => {
    const rows = notificationEventRows(null);
    expect(rows.map((row) => row.label)).toEqual([
      "A bot finishes a task",
      "A bot needs your input or approval",
      "A task fails",
      "A routine finishes",
      "A bot replies in a chat you are not reading",
    ]);
    expect(rows.every((row) => row.value)).toBe(true);
  });

  it("keeps a saved off value", () => {
    const rows = notificationEventRows({
      taskCompleted: false,
      taskNeedsInput: true,
      taskFailed: true,
      routineResult: true,
      chatReply: true,
    });
    expect(rows[0]?.value).toBe(false);
  });

  it("names a device and reports its last delivery", () => {
    const device = {
      deviceLabel: "Find X9 Pro",
      endpointHost: "push.example.com",
      lastSuccessAt: DateTime.makeUnsafe("2026-11-05T10:00:00.000Z"),
      lastFailureAt: null,
      lastError: null,
    } as unknown as PersonalPushDevice;
    expect(notificationDevicesLine(device)).toBe("Find X9 Pro · push.example.com");
    expect(notificationDeviceDetail(device, Date.parse("2026-11-05T10:04:00.000Z"))).toBe(
      "Last delivered 4m",
    );
  });
});
