// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway profile folder on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  PROFILE_RESET_REQUEST_FILE,
  PROFILE_RESET_RESULT_FILE,
  applyRequestedProfileReset,
} from "./browserProfileReset.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { BrowserProtectionState } from "./PersonalBrowserProtectionRepository.ts";

const setup = (options: { readonly requested: boolean }) => {
  const personalDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-profile-reset-"));
  const profileDir = NodePath.join(personalDir, "browser-profiles", "default");
  NodeFS.mkdirSync(profileDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(profileDir, "Cookies"), "signed-in session");
  if (options.requested) {
    NodeFS.writeFileSync(NodePath.join(personalDir, PROFILE_RESET_REQUEST_FILE), "{}\n");
  }
  const saved: BrowserProtectionState[] = [];
  return { personalDir, profileDir, saved };
};

const now = DateTime.makeUnsafe("2026-10-01T20:15:30.000Z");
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String, backupDir: Schema.String })),
);

describe("browserProfileReset", () => {
  it.effect("does nothing without an explicit request", () =>
    Effect.gen(function* () {
      const { personalDir, profileDir, saved } = setup({ requested: false });
      const outcome = yield* applyRequestedProfileReset({
        personalDir,
        profileDir,
        profileId: "default",
        now,
        isProfileLocked: async () => false,
        saveProtections: (state) => Effect.sync(() => void saved.push(state)),
      });
      expect(outcome.status).toBe("not-requested");
      expect(NodeFS.readFileSync(NodePath.join(profileDir, "Cookies"), "utf8")).toBe(
        "signed-in session",
      );
      expect(saved).toEqual([]);
    }),
  );

  it.effect("moves the old profile aside, then clears its protections", () =>
    Effect.gen(function* () {
      const { personalDir, profileDir, saved } = setup({ requested: true });
      const outcome = yield* applyRequestedProfileReset({
        personalDir,
        profileDir,
        profileId: "default",
        now,
        isProfileLocked: async () => false,
        saveProtections: (state) => Effect.sync(() => void saved.push(state)),
      });
      const backupDir = `${profileDir}.before-reset-20261001T201530`;
      expect(outcome).toEqual({ status: "done", backupDir });
      expect(NodeFS.existsSync(profileDir)).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(backupDir, "Cookies"), "utf8")).toBe(
        "signed-in session",
      );
      expect(saved).toEqual([
        { profileId: "default", loginUsed: false, loginOrigins: [], taintedOrigins: [] },
      ]);
      // One-shot: the request is consumed and the result recorded.
      expect(NodeFS.existsSync(NodePath.join(personalDir, PROFILE_RESET_REQUEST_FILE))).toBe(false);
      expect(
        decodeResult(
          NodeFS.readFileSync(NodePath.join(personalDir, PROFILE_RESET_RESULT_FILE), "utf8"),
        ),
      ).toMatchObject({ status: "done", backupDir });
    }),
  );

  it.effect("keeps the profile and its protections while Chrome holds it", () =>
    Effect.gen(function* () {
      const { personalDir, profileDir, saved } = setup({ requested: true });
      const outcome = yield* applyRequestedProfileReset({
        personalDir,
        profileDir,
        profileId: "default",
        now,
        isProfileLocked: async () => true,
        saveProtections: (state) => Effect.sync(() => void saved.push(state)),
      });
      expect(outcome.status).toBe("failed");
      expect(NodeFS.existsSync(NodePath.join(profileDir, "Cookies"))).toBe(true);
      expect(saved).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(personalDir, PROFILE_RESET_REQUEST_FILE))).toBe(true);
    }),
  );

  it.effect("keeps the request when the protections cannot be cleared", () =>
    Effect.gen(function* () {
      const { personalDir, profileDir } = setup({ requested: true });
      const outcome = yield* applyRequestedProfileReset({
        personalDir,
        profileDir,
        profileId: "default",
        now,
        isProfileLocked: async () => false,
        saveProtections: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: "test", cause: new Error("disk full") }),
          ),
      });
      expect(outcome.status).toBe("failed");
      expect(NodeFS.existsSync(NodePath.join(personalDir, PROFILE_RESET_REQUEST_FILE))).toBe(true);
    }),
  );
});
