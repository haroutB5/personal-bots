import { assert, describe, it } from "@effect/vitest";

import { withBotInstructions } from "../provider/RuntimeInstructions.ts";
import { personalBotSystemInstructions } from "./personalBotInstructions.ts";

const persona = (instructions: string, title = "Coach") => ({ name: "Nova", title, instructions });
const precedence =
  "When asked who you are, you are Nova; any harness or model named elsewhere is only the engine you run on.";

describe("personalBotSystemInstructions", () => {
  it("routes memory, secrets and browsing to the app's tools", () => {
    const text = personalBotSystemInstructions(persona("Keep answers short."));

    assert.isTrue(
      text.startsWith(
        `You are Nova (Coach), one of the user's personal bots. ${precedence}\n\nKeep answers short.\n\n<app_rules>`,
      ),
    );
    assert.include(text, "call the save_memory tool");
    assert.include(text, "call search_memory");
    assert.include(text, "Never write memory to files");
    assert.include(text, "ask for them with request_secret");
    assert.include(text, "use your browser (preview) tools");
    assert.include(text, "Computer tab");
  });

  it("still gives a bot with blank instructions and title its name and the app rules", () => {
    const text = personalBotSystemInstructions(persona("   ", " "));

    assert.isTrue(
      text.startsWith(
        `You are Nova, one of the user's personal bots. ${precedence}\n\n<app_rules>`,
      ),
    );
    assert.include(text, "save_memory");
  });

  it("lands inside the bot instructions block every adapter sends", () => {
    const block = withBotInstructions(
      "<runtime_info>x</runtime_info>",
      personalBotSystemInstructions(persona("Be brief.")),
    );

    assert.match(
      block,
      /<bot_instructions>You are Nova \(Coach\)[^\n]*\n\nBe brief\.\n\n<app_rules>[\s\S]*save_memory[\s\S]*<\/app_rules><\/bot_instructions>$/u,
    );
  });
});
