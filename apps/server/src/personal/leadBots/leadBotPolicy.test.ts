import { PersonalBotId, ProviderInstanceId, type PersonalBot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  authorizeLeadBotAction,
  isLeadForbiddenModel,
  LEAD_BOT_CREATES_PER_DAY,
  looksLikeSecret,
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
  targetOpenTasks: 0,
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
      expect(authorizeLeadBotAction(facts({ action }))).toEqual({ allowed: true, team: "Finance" });
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
    // A seeded system bot is reachable only when it sits on the caller's team.
    expect(refusedWith({ target: bot("updates", { team: "assistant" }) })).toBe("other_team");
    expect(refusedWith({ target: bot("updates", { team: "Finance" }) })).toBe("allowed");
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
      const requestedModel = { instanceId: "claudeAgent", model };
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
        requestedModel: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
      }),
    ).toBe("allowed");
    expect(
      refusedWith({
        target: onFable,
        requestedModel: { instanceId: "other", model: "claude-fable-5-1" },
      }),
    ).toBe("forbidden_model");
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
