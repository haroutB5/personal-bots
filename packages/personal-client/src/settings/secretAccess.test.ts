import { describe, expect, it } from "vite-plus/test";

import {
  initialSecretAccess,
  secretAccessChoice,
  secretAccessProblem,
  type SecretAccessState,
} from "./secretAccess.ts";

const state = (overrides: Partial<SecretAccessState> = {}): SecretAccessState => ({
  ...initialSecretAccess(),
  ...overrides,
});

describe("secretAccessProblem", () => {
  it("asks for an address when a brokered key has none", () => {
    expect(secretAccessProblem(state())).toBe(
      "Enter the address this key may be sent to, like https://api.vercel.com.",
    );
  });

  it("accepts a public https address", () => {
    expect(secretAccessProblem(state({ originsText: "https://api.vercel.com" }))).toBeNull();
  });

  it("rejects a local or plain-http address", () => {
    expect(secretAccessProblem(state({ originsText: "http://localhost:3000" }))).toContain(
      "public https:// address",
    );
  });

  it("does not ask for an address for an environment variable", () => {
    expect(secretAccessProblem(state({ mode: "env" }))).toBeNull();
  });
});

describe("secretAccessChoice", () => {
  it("keeps the typed addresses and the default placement", () => {
    expect(secretAccessChoice(state({ originsText: "https://api.vercel.com" }))).toEqual({
      mode: "brokered",
      origins: ["https://api.vercel.com"],
      placement: {},
    });
  });

  it("sends an environment variable with no address", () => {
    expect(secretAccessChoice(state({ mode: "env" }))).toEqual({
      mode: "env",
      origins: [],
      placement: {},
    });
  });

  it("starts from the address the bot asked for", () => {
    expect(initialSecretAccess(["https://api.openai.com"]).originsText).toBe(
      "https://api.openai.com",
    );
  });
});
