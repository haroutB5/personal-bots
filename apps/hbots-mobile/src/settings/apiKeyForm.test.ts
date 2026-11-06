import {
  initialSecretAccess,
  type SecretAccessState,
} from "@hbots/personal-client/settings/secretAccess";
import { describe, expect, it } from "vite-plus/test";

import { apiKeyFormProblem, apiKeyErrorScrollTarget } from "./apiKeyForm";

const access = (fields: Partial<SecretAccessState> = {}): SecretAccessState => ({
  ...initialSecretAccess(),
  ...fields,
});

describe("apiKeyFormProblem", () => {
  it("names the empty field that blocks Save", () => {
    expect(apiKeyFormProblem({ name: "", value: "sk-live", access: access() })).toEqual({
      field: "name",
      message: "Give the key a name.",
    });
    expect(apiKeyFormProblem({ name: "TAVILY_API_KEY", value: "", access: access() })).toEqual({
      field: "value",
      message: "Paste the key's value.",
    });
  });

  it("rejects a name that bots cannot ask for", () => {
    expect(apiKeyFormProblem({ name: "tavily", value: "sk-live", access: access() })?.field).toBe(
      "name",
    );
    expect(
      apiKeyFormProblem({
        name: "TAVILY_API_KEY",
        value: "sk-live",
        access: access({ originsText: "https://api.tavily.com" }),
      }),
    ).toBeNull();
  });

  it("puts a missing allowed address under the access field", () => {
    const problem = apiKeyFormProblem({
      name: "TAVILY_API_KEY",
      value: "sk-live",
      access: access({ mode: "brokered", originsText: "" }),
    });
    expect(problem?.field).toBe("access");
    expect(problem?.message).toContain("Enter the address this key may be sent to");
  });

  it("accepts an environment variable without an address", () => {
    expect(
      apiKeyFormProblem({
        name: "TAVILY_API_KEY",
        value: "sk-live",
        access: access({ mode: "env", originsText: "" }),
      }),
    ).toBeNull();
  });
});

describe("apiKeyErrorScrollTarget", () => {
  it("scrolls the blocked address field above the keyboard", () => {
    expect(
      apiKeyErrorScrollTarget({
        fieldBottom: 650,
        viewportHeight: 683,
        keyboardInset: 299,
      }),
    ).toBe(278);
    expect(650 - 278).toBe(372);
    expect(372).toBeLessThanOrEqual(683 - 299);
  });

  it("targets the top when the field fits in the first viewport", () => {
    expect(
      apiKeyErrorScrollTarget({
        fieldBottom: 300,
        viewportHeight: 683,
        keyboardInset: 299,
      }),
    ).toBe(0);
  });
});
