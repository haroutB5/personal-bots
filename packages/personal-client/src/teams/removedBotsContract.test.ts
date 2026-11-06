import { describe, expect, it } from "@effect/vitest";
import { PersonalBotRestoreInput, WS_METHODS } from "@t3tools/contracts";
import { Schema } from "effect";

const decodeRestore = Schema.decodeUnknownSync(PersonalBotRestoreInput);

describe("A11 rpc contract", () => {
  it("names the two removed-bot tags the phone and the web call", () => {
    expect(WS_METHODS.personalBotsListRemoved).toBe("personalBots.listRemoved");
    expect(WS_METHODS.personalBotsRestore).toBe("personalBots.restore");
  });

  it("decodes the restore input the phone sends", () => {
    expect(decodeRestore({ botId: "bot-ada" })).toEqual({ botId: "bot-ada" });
  });
});
