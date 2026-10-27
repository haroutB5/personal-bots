import { writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { advertisedToolList } from "../mcp/advertisedTools.ts";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import { buildRuntimeInstructions, withBotInstructions } from "../provider/RuntimeInstructions.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import {
  PERSONAL_BOT_APP_RULES,
  personalBotSystemInstructions,
} from "./personalBotInstructions.ts";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

// The app's own part of a bot's prompt. A bot's own instructions are the owner's text, so the
// persona here has none; the identity, engine and memory lines are what every bot gets.
const botPrompt = personalBotSystemInstructions({
  name: "Budget",
  title: "Context budget",
  instructions: "",
  model: "claude-opus-5-5",
  effort: "high",
  memoryAutoSave: true,
});

const claudeSystemAppend = () =>
  withBotInstructions(buildRuntimeInstructions({ harness: "Claude Code" }), botPrompt);

const codexAdditionalContext = () =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true },
      botPrompt,
    ),
  )
    .map((entry) => entry.value)
    .join("");

// A change that grows any value fails here; lower the values when the text shrinks, so the
// budget only ratchets down. Raising one needs the owner's OK and evidence in the commit.
it("bot context matches the committed budget", () => {
  const tools = advertisedToolList();
  const measured = {
    appRulesBytes: utf8Bytes(PERSONAL_BOT_APP_RULES),
    claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
    codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
    mcpToolCount: tools.length,
    mcpToolListJsonBytes: utf8Bytes(JSON.stringify(tools)),
  };
  // Measurement hook for before/after reports: writes what the model sees, nothing else.
  const dump = process.env.HBOTS_AGENT_CONTEXT_DUMP;
  if (dump !== undefined && dump.length > 0) {
    writeFileSync(
      dump,
      JSON.stringify(
        {
          measured,
          tools,
          appRules: PERSONAL_BOT_APP_RULES,
          claudeSystemAppend: claudeSystemAppend(),
          codexAdditionalContext: codexAdditionalContext(),
        },
        null,
        2,
      ),
    );
  }

  expect(measured).toEqual(budget);
});
