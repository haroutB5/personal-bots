import { describe, expect, it } from "vite-plus/test";

import { emptyPasswordDraft, validatePasswordDraft } from "./passwordsModel";

describe("password form model", () => {
  // Saved logins are shared by every bot, so the draft carries no grants at all.
  it("starts empty, with no per-bot fields to carry", () => {
    expect(Object.keys(emptyPasswordDraft()).toSorted()).toEqual([
      "label",
      "origin",
      "password",
      "username",
    ]);
  });

  it("requires a canonical exact https origin and a newly entered password", () => {
    expect(
      validatePasswordDraft({
        label: "Example",
        origin: "https://example.com",
        username: "person@example.com",
        password: "entered-now",
      }),
    ).toEqual({});
    expect(
      validatePasswordDraft({
        label: "Example",
        origin: "https://example.com/account",
        username: "person@example.com",
        password: "",
      }),
    ).toEqual({
      origin: "Enter an exact HTTPS origin, such as https://example.com.",
      password: "Re-enter the password to save.",
    });
  });
});
