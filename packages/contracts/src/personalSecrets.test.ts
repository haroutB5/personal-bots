import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_SECRET_MAX_ORIGINS,
  normalizePersonalSecretOrigin,
  normalizePersonalSecretOrigins,
  personalSecretPlaceholder,
} from "./personalSecrets.ts";

describe("normalizePersonalSecretOrigin", () => {
  it("accepts a bare host, an origin and a full address, and keeps only the origin", () => {
    expect(normalizePersonalSecretOrigin("api.vercel.com")).toBe("https://api.vercel.com");
    expect(normalizePersonalSecretOrigin("https://api.vercel.com")).toBe("https://api.vercel.com");
    expect(normalizePersonalSecretOrigin("  HTTPS://API.Vercel.com/v9/projects?x=1#y ")).toBe(
      "https://api.vercel.com",
    );
    expect(normalizePersonalSecretOrigin("https://api.vercel.com:443/x")).toBe(
      "https://api.vercel.com",
    );
  });

  it("keeps a non-default port, which makes it a different origin", () => {
    expect(normalizePersonalSecretOrigin("api.example.com:8443")).toBe(
      "https://api.example.com:8443",
    );
  });

  it("refuses anything that is not a public HTTPS site", () => {
    for (const bad of [
      "",
      "   ",
      "http://api.vercel.com",
      "ftp://api.vercel.com",
      "javascript:alert(1)",
      "mailto:a@b.com",
      "https://user:pw@api.vercel.com",
      "https://api.vercel.com@evil.example",
      "https://127.0.0.1",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://2130706433",
      "https://0x7f.1",
      "localhost",
      "https://localhost:3000",
      "printer.local",
      "nas.lan",
      "https://service.internal",
      "https://intranet",
      "https://a b.com",
      "https://-bad-.com",
      "https://exa_mple.com",
      `https://${"a".repeat(400)}.com`,
    ]) {
      expect(normalizePersonalSecretOrigin(bad), bad).toBeNull();
    }
  });
});

describe("normalizePersonalSecretOrigins", () => {
  it("drops duplicates and refuses the whole list when one entry is bad", () => {
    expect(
      normalizePersonalSecretOrigins(["api.vercel.com", "https://api.vercel.com/x", "serpapi.com"]),
    ).toEqual(["https://api.vercel.com", "https://serpapi.com"]);
    expect(
      normalizePersonalSecretOrigins(["api.vercel.com", "http://nope.example.com"]),
    ).toBeNull();
    expect(normalizePersonalSecretOrigins([])).toEqual([]);
  });

  it("allows at most the maximum number of origins", () => {
    const many = Array.from(
      { length: PERSONAL_SECRET_MAX_ORIGINS + 1 },
      (_, index) => `api${index}.example.com`,
    );
    expect(normalizePersonalSecretOrigins(many.slice(0, PERSONAL_SECRET_MAX_ORIGINS))).toHaveLength(
      PERSONAL_SECRET_MAX_ORIGINS,
    );
    expect(normalizePersonalSecretOrigins(many)).toBeNull();
  });
});

describe("personalSecretPlaceholder", () => {
  it("is the text a bot writes where a brokered key's value belongs", () => {
    expect(personalSecretPlaceholder("VERCEL_TOKEN")).toBe("{{secret:VERCEL_TOKEN}}");
  });
});
