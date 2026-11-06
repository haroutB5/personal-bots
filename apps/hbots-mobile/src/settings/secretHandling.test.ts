import { PersonalLoginId } from "@t3tools/contracts";
import { initialSecretAccess } from "@hbots/personal-client/settings/secretAccess";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { buildApiKeyInput, buildLoginInput, draftAfterAppState } from "./secretHandling";

const SECRET = "sk-live-this-must-never-travel";

describe("credential drafts", () => {
  it("keeps a draft only while the app is in front", () => {
    expect(draftAfterAppState("active", SECRET)).toBe(SECRET);
    expect(draftAfterAppState("background", SECRET)).toBe("");
    expect(draftAfterAppState("inactive", SECRET)).toBe("");
  });

  it("wraps a login password in Redacted before it leaves the form", () => {
    const input = buildLoginInput(
      PersonalLoginId.make("login-1"),
      { label: " Work ", origin: "https://example.com", username: "harout", password: SECRET },
      SECRET,
    );
    expect(Redacted.value(input.password)).toBe(SECRET);
    expect(input.label).toBe("Work");
    expect(JSON.stringify(input)).not.toContain(SECRET);
    expect(String(input.password)).not.toContain(SECRET);
  });

  it("wraps an API key value and sends the access choice", () => {
    const input = buildApiKeyInput("TAVILY_API_KEY", " Tavily ", SECRET, {
      ...initialSecretAccess(["https://api.tavily.com"]),
      mode: "brokered",
    });
    expect(Redacted.value(input.value)).toBe(SECRET);
    expect(input.label).toBe("Tavily");
    expect(input.shared).toBe(true);
    expect(input.origins).toEqual(["https://api.tavily.com"]);
    expect(input.mode).toBe("brokered");
    expect(JSON.stringify(input)).not.toContain(SECRET);
  });
});
