import { PersonalBotId, ProviderInstanceId, type PersonalBot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  authorizeLeadBotAction,
  busyRefusal,
  checkBotName,
  isLeadForbiddenModel,
  isProtectedBot,
  LEAD_BOT_CREATES_PER_DAY,
  looksLikeSecret,
  normalizeBotNameKey,
  rawBotNameKey,
  type LeadBotFacts,
} from "./leadBotPolicy.ts";

const bot = (key: string, overrides: Partial<PersonalBot> = {}): PersonalBot =>
  ({
    botId: PersonalBotId.make(`bot-${key}`),
    name: key,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-x" },
    enabled: true,
    sortOrder: 0,
    team: "Finance",
    lead: false,
    pinned: false,
    createdAt: undefined,
    updatedAt: undefined,
    ...overrides,
  }) as unknown as PersonalBot;

const CFO = bot("cfo", { lead: true });
const MEMBER = bot("tax");

const facts = (overrides: Partial<LeadBotFacts>): LeadBotFacts => ({
  action: "update",
  caller: CFO,
  target: MEMBER,
  forbiddenFields: [],
  requestedModel: null,
  createsInWindow: 0,
  // A bot this lead made and that stayed on its team: fully the lead's to manage.
  // The cases about a bot it does not own set targetOwnedByCaller false.
  sensitiveChanges: [],
  targetOwnedByCaller: true,
  ownerTurn: true,
  targetOpenTasks: 0,
  targetActiveSessions: 0,
  targetActiveRoutines: 0,
  ...overrides,
});

const refusedWith = (overrides: Partial<LeadBotFacts>) => {
  const verdict = authorizeLeadBotAction(facts(overrides));
  return verdict.allowed ? "allowed" : verdict.code;
};

describe("authorizeLeadBotAction", () => {
  it("allows a lead to create, edit and remove a member of its own team", () => {
    for (const action of ["create", "update", "remove"] as const) {
      expect(authorizeLeadBotAction(facts({ action }))).toEqual({
        allowed: true,
        team: "Finance",
        confirm: false,
      });
    }
  });

  it("refuses a caller that is not a lead, or is gone, for every action", () => {
    for (const action of ["create", "update", "remove"] as const) {
      expect(refusedWith({ action, caller: bot("cfo", { lead: false }) })).toBe("not_a_lead");
      expect(
        refusedWith({ action, caller: { ...CFO, lead: undefined } as unknown as PersonalBot }),
      ).toBe("not_a_lead");
      expect(refusedWith({ action, caller: null })).toBe("caller_gone");
    }
  });

  it("refuses itself, another team's bot, another team's lead and a lead of its own team", () => {
    expect(refusedWith({ target: CFO })).toBe("self");
    expect(refusedWith({ target: bot("dev", { team: "dev" }) })).toBe("other_team");
    expect(refusedWith({ target: bot("cto", { team: "dev", lead: true }) })).toBe("other_team");
    // A lead flag on the caller's own team (a case variant of the name can
    // leave two) is still not the caller's to change.
    expect(refusedWith({ target: bot("cfo2", { team: "finance", lead: true }) })).toBe(
      "other_lead",
    );
    expect(refusedWith({ target: null })).toBe("no_such_bot");
    // A bot on another team that is not a system bot: other_team.
    expect(refusedWith({ target: bot("scout", { team: "assistant" }) })).toBe("other_team");
    // Team names compare the way the app does: case-insensitively.
    expect(refusedWith({ target: bot("tax", { team: "finance" }) })).toBe("allowed");
  });

  it("refuses a call that names team, lead or pinned, and does not care what value", () => {
    for (const action of ["create", "update"] as const) {
      for (const field of ["team", "lead", "pinned"] as const) {
        expect(refusedWith({ action, forbiddenFields: [field] })).toBe("forbidden_field");
      }
    }
  });

  it("refuses a Fable or Mythos model unless the bot already has it", () => {
    for (const model of ["claude-fable-5-1", "claude-mythos-1", "Claude-FABLE-2"]) {
      expect(isLeadForbiddenModel(model)).toBe(true);
      const requestedModel = { instanceId: "claudeAgent", model, changed: true };
      expect(refusedWith({ action: "create", requestedModel })).toBe("forbidden_model");
      expect(refusedWith({ action: "update", requestedModel })).toBe("forbidden_model");
    }
    expect(isLeadForbiddenModel("claude-opus-5-5")).toBe(false);
    // The user's own choice is left alone: same instance and model, unchanged.
    const onFable = bot("tax", {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5-1",
      },
    });
    expect(
      refusedWith({
        target: onFable,
        requestedModel: { instanceId: "claudeAgent", model: "claude-fable-5-1", changed: false },
      }),
    ).toBe("allowed");
    expect(
      refusedWith({
        target: onFable,
        requestedModel: { instanceId: "other", model: "claude-fable-5-1", changed: true },
      }),
    ).toBe("forbidden_model");
    // Effort counts as a change: the same Fable model at a higher effort is refused.
    expect(
      refusedWith({
        target: onFable,
        requestedModel: { instanceId: "claudeAgent", model: "claude-fable-5-1", changed: true },
      }),
    ).toBe("forbidden_model");
  });

  it("never lets a lead touch a protected bot, on any team, before the team check", () => {
    const updates = bot("updates", {
      botId: PersonalBotId.make("personal-claude-code-updates"),
      team: "dev",
      name: "Updates",
    });
    const seeded = bot("planner", {
      botId: PersonalBotId.make("personal-seed-planner"),
      team: "assistant",
    });
    const sync = bot("sync", {
      botId: PersonalBotId.make("bc127d8a-6f93-479a-94a0-a875e28f54eb"),
      name: "Sync reports",
      team: "dev",
    });
    // Its name in disguise: case, spacing and an invisible character do not help.
    const disguised = bot("sync2", { name: "Sync​  Reports" });
    for (const target of [updates, seeded, sync, disguised]) {
      expect(isProtectedBot(target)).toBe(true);
      for (const action of ["update", "remove"] as const) {
        expect(refusedWith({ action, target })).toBe("protected");
      }
    }
    // Also when it sits on the lead's own team (the old fixture put Updates on "assistant").
    const onOwnTeam = bot("updates2", {
      botId: PersonalBotId.make("personal-claude-code-updates"),
      name: "Updates",
      team: "Finance",
    });
    expect(refusedWith({ target: onOwnTeam })).toBe("protected");
    expect(refusedWith({ action: "remove", target: onOwnTeam })).toBe("protected");
    // An ordinary bot, whatever its name looks like, is not.
    expect(isProtectedBot(bot("tax"))).toBe(false);
    expect(isProtectedBot(bot("sync-helper", { name: "Sync helper" }))).toBe(false);
  });

  it("puts a bot the lead does not own to the user on a card, and only from a turn the user started", () => {
    const notOwned = { targetOwnedByCaller: false } as const;
    const verdictOf = (overrides: Partial<LeadBotFacts>) =>
      authorizeLeadBotAction(facts(overrides));
    // Remove: allowed, but as a card (confirm) rather than at once.
    expect(verdictOf({ ...notOwned, action: "remove" })).toMatchObject({
      allowed: true,
      confirm: true,
    });
    // A routine, task, group or server turn cannot raise a card, and the reason says who to ask.
    const noOwnerTurn = verdictOf({ ...notOwned, action: "remove", ownerTurn: false });
    expect(noOwnerTurn.allowed).toBe(false);
    expect(!noOwnerTurn.allowed && noOwnerTurn.code).toBe("needs_owner");
    expect(!noOwnerTurn.allowed && noOwnerTurn.reason).toContain(
      "Ask Harout to request this in chat",
    );
    // A bot this lead made and kept on its team is done at once, in any kind of turn.
    for (const ownerTurn of [true, false]) {
      expect(verdictOf({ action: "remove", targetOwnedByCaller: true, ownerTurn })).toMatchObject({
        allowed: true,
        confirm: false,
      });
    }
    // Update: each sensitive field goes through a card, cosmetic ones do not.
    for (const field of ["name", "instructions", "description", "model"] as const) {
      const change = { ...notOwned, action: "update", sensitiveChanges: [field] } as const;
      expect(verdictOf(change)).toMatchObject({ allowed: true, confirm: true });
      expect(refusedWith({ ...change, ownerTurn: false })).toBe("needs_owner");
      expect(
        verdictOf({ action: "update", sensitiveChanges: [field], ownerTurn: false }),
      ).toMatchObject({ allowed: true, confirm: false });
    }
    expect(
      verdictOf({ ...notOwned, action: "update", sensitiveChanges: [], ownerTurn: false }),
    ).toMatchObject({ allowed: true, confirm: false });
    // Create never asks.
    expect(verdictOf({ ...notOwned, action: "create", ownerTurn: false })).toMatchObject({
      allowed: true,
      confirm: false,
    });
    // The owner's tap on exactly this change meets the requirement, in any turn; every
    // other rule still applies to it.
    expect(
      verdictOf({ ...notOwned, action: "remove", ownerTurn: false, approvedByOwner: true }),
    ).toMatchObject({ allowed: true, confirm: false });
    expect(
      refusedWith({ ...notOwned, action: "remove", approvedByOwner: true, targetOpenTasks: 1 }),
    ).toBe("running_task");
    expect(
      refusedWith({
        ...notOwned,
        action: "remove",
        approvedByOwner: true,
        target: bot("boss", { lead: true }),
      }),
    ).toBe("other_lead");
  });

  it("refuses removing a bot mid-turn, and the transaction's check says the same", () => {
    expect(refusedWith({ action: "remove", targetActiveSessions: 1 })).toBe("running_task");
    expect(refusedWith({ action: "update", targetActiveSessions: 1 })).toBe("allowed");
    expect(busyRefusal({ name: "Tax" }, 0, 0)).toBeNull();
    expect(busyRefusal({ name: "Tax" }, 2, 0)).toMatchObject({
      allowed: false,
      code: "running_task",
    });
    expect(busyRefusal({ name: "Tax" }, 0, 1)).toMatchObject({
      allowed: false,
      code: "running_task",
    });
  });

  it("limits creates per rolling day, and only creates", () => {
    expect(refusedWith({ action: "create", createsInWindow: LEAD_BOT_CREATES_PER_DAY - 1 })).toBe(
      "allowed",
    );
    expect(refusedWith({ action: "create", createsInWindow: LEAD_BOT_CREATES_PER_DAY })).toBe(
      "rate_limit",
    );
    expect(refusedWith({ action: "update", createsInWindow: LEAD_BOT_CREATES_PER_DAY })).toBe(
      "allowed",
    );
  });

  it("refuses removing a bot with an unfinished task or a routine switched on", () => {
    expect(refusedWith({ action: "remove", targetOpenTasks: 1 })).toBe("running_task");
    expect(refusedWith({ action: "remove", targetActiveRoutines: 2 })).toBe("active_routines");
    // Editing such a bot is fine.
    expect(refusedWith({ action: "update", targetOpenTasks: 1, targetActiveRoutines: 1 })).toBe(
      "allowed",
    );
  });
});

describe("checkBotName", () => {
  it("normalises and accepts plain names in one alphabet", () => {
    expect(checkBotName("  Tax   adviser ")).toEqual({ ok: true, name: "Tax adviser" });
    // NFKC folds compatibility forms: a fullwidth name becomes the plain one.
    expect(checkBotName("Ｔａｘ")).toEqual({ ok: true, name: "Tax" });
    expect(checkBotName("Бухгалтер")).toEqual({ ok: true, name: "Бухгалтер" });
    expect(checkBotName("Helper 2")).toEqual({ ok: true, name: "Helper 2" });
    expect(checkBotName("税務アシスタント").ok).toBe(true);
  });

  it("refuses invisible characters, mixed alphabets and names that are too short", () => {
    for (const bad of ["Ta​x", "‏Maxi2", "Tax‮", "Ta﻿x"]) {
      expect(checkBotName(bad)).toMatchObject({ ok: false });
    }
    // Latin with a Cyrillic "а": the classic lookalike.
    expect(checkBotName("Bаckend")).toMatchObject({ ok: false });
    expect(checkBotName("Ελληνικά and Latin")).toMatchObject({ ok: false });
    for (const short of ["", "  ", "AI", "12", "1 2", "---", "!!!", "555"]) {
      expect(checkBotName(short)).toMatchObject({ ok: false });
    }
    expect(checkBotName("AI2")).toEqual({ ok: true, name: "AI2" });
  });

  it("checks the name as submitted as well as its normal form", () => {
    // Each of these normalises to something valid; the raw name is what is refused.
    // A ligature that expands to three letters (raw: one character).
    expect(checkBotName("\ufb03")).toMatchObject({ ok: false });
    expect("\ufb03".normalize("NFKC")).toBe("ffi");
    // Styled maths capitals next to plain letters: raw mixes "alphabets", normal is plain Latin.
    expect("\u{1D5D4}dmin".normalize("NFKC")).toBe("Admin");
    expect(checkBotName("\u{1D5D4}dmin")).toMatchObject({ ok: false });
    // The same name with a soft hyphen or a word joiner hidden inside.
    expect(checkBotName("Ad\u00admin")).toMatchObject({ ok: false });
    expect(checkBotName("Ad\u2060min")).toMatchObject({ ok: false });
    // Plain and fullwidth Latin are still fine, and the stored form is the normal one.
    expect(checkBotName("\uff21dmin")).toEqual({ ok: true, name: "Admin" });
  });

  it("compares names in one normal form and as submitted", () => {
    expect(rawBotNameKey("  Tax   ADVISER ")).toBe("tax adviser");
    expect(rawBotNameKey("\uff34ax")).not.toBe(rawBotNameKey("Tax"));
    expect(normalizeBotNameKey("\uff34ax")).toBe(normalizeBotNameKey("Tax"));
    expect(normalizeBotNameKey("Ｔax  ADVISER")).toBe(normalizeBotNameKey("tax adviser"));
    expect(normalizeBotNameKey("‏Maxi2")).toBe(normalizeBotNameKey("maxi2"));
  });
});

describe("looksLikeSecret", () => {
  it("catches the usual credential shapes and the app's own variable names", () => {
    for (const text of [
      "use PB_SECRET_GITHUB_TOKEN to push",
      "key sk-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "-----BEGIN RSA PRIVATE KEY-----",
      "AKIAABCDEFGHIJKLMNOP",
    ]) {
      expect(looksLikeSecret(text)).toBe(true);
    }
    expect(looksLikeSecret("You prepare tax summaries and never guess a figure.")).toBe(false);
  });
});
