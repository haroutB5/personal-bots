import { PersonalBotId, ProviderInstanceId, type PersonalBot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { withGroupPresence } from "./groupOnlyBots.ts";

const at = DateTime.makeUnsafe("2026-09-24T21:00:00.000Z");
const bot = (id: string): PersonalBot => ({
  botId: PersonalBotId.make(id),
  name: id,
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  enabled: true,
  sortOrder: 0,
  createdAt: at,
  updatedAt: at,
});

describe("withGroupPresence", () => {
  it("marks a bot group-only only when it is in a group and has no private chat", () => {
    const result = withGroupPresence(
      [bot("luna"), bot("sol"), bot("ada"), bot("new")],
      [
        { botId: PersonalBotId.make("luna"), groupIds: ["g2", "g1"], hasPrivateChat: false },
        { botId: PersonalBotId.make("sol"), groupIds: ["g1"], hasPrivateChat: true },
        { botId: PersonalBotId.make("ada"), groupIds: [], hasPrivateChat: false },
      ],
    );
    expect(result.map((entry) => [entry.botId, entry.groupOnly, entry.groupIds])).toEqual([
      ["luna", true, ["g1", "g2"]],
      ["sol", false, ["g1"]],
      ["ada", false, []],
      // Missing from the presence rows (a create racing the list): shown, never lost.
      ["new", false, []],
    ]);
  });

  it("keeps every other field of the bot", () => {
    const [stamped] = withGroupPresence([bot("luna")], []);
    expect(stamped).toMatchObject({ botId: "luna", name: "luna", enabled: true });
  });
});
