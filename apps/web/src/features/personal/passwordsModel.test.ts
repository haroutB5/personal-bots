import { describe, expect, it } from "vite-plus/test";

import { emptyPasswordDraft, setPasswordBotGrant, validatePasswordDraft } from "./passwordsModel";

describe("password form model", () => {
  it("starts with no bot grants and toggles grants independently", () => {
    const empty = emptyPasswordDraft();
    expect(empty.botIds).toEqual([]);
    const first = setPasswordBotGrant(empty.botIds, "bot-a", true);
    const both = setPasswordBotGrant(first, "bot-b", true);
    expect(both).toEqual(["bot-a", "bot-b"]);
    expect(setPasswordBotGrant(both, "bot-a", false)).toEqual(["bot-b"]);
  });

  it("requires a canonical exact https origin and a newly entered password", () => {
    expect(
      validatePasswordDraft({
        label: "Example",
        origin: "https://example.com",
        username: "person@example.com",
        password: "entered-now",
        botIds: [],
      }),
    ).toEqual({});
    expect(
      validatePasswordDraft({
        label: "Example",
        origin: "https://example.com/account",
        username: "person@example.com",
        password: "",
        botIds: [],
      }),
    ).toEqual({
      origin: "Enter an exact HTTPS origin, such as https://example.com.",
      password: "Re-enter the password to save.",
    });
  });
});
