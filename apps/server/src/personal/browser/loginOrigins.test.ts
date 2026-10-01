import * as NodeVM from "node:vm";

import { describe, expect, it } from "@effect/vitest";

import {
  LOGIN_SCRIPT_REFUSED,
  guardedExpression,
  loginCookieScope,
  loginCookieScopes,
  loginOriginCovering,
} from "./loginOrigins.ts";

/** Evaluates like Playwright does, in a document at `url`. */
const runAt = (url: string, expression: string, globals: Record<string, unknown> = {}) =>
  NodeVM.runInNewContext(expression, Object.assign(globals, { location: new URL(url) }));

describe("loginOrigins", () => {
  it("scopes a login to its registrable site, or its exact host when there is none", () => {
    expect(loginCookieScope("https://app.example.com")).toBe("example.com");
    expect(loginCookieScope("https://www.bank.co.uk")).toBe("bank.co.uk");
    expect(loginCookieScope("https://alpha.vercel.app")).toBe("alpha.vercel.app");
    expect(loginCookieScope("http://127.0.0.1:4000")).toBe("127.0.0.1");
    expect(loginCookieScope("http://localhost:3000")).toBe("localhost");
    expect(loginCookieScope("http://[::1]:3000")).toBe("[::1]");
    expect(loginCookieScope("not a url")).toBeNull();
    expect(loginCookieScope("file:///c:/x")).toBeNull();
    expect(loginCookieScopes(["https://a.example.com", "http://b.example.com"])).toEqual([
      "example.com",
    ]);
    expect(loginCookieScopes(["https://a.example.com", "nope"])).toBeNull();
  });

  it("finds the login a page shares cookies with", () => {
    const logins = ["https://app.example.com", "http://127.0.0.1:4000"];
    expect(loginOriginCovering("https://www.example.com/x", logins)).toEqual({
      origin: "https://app.example.com",
    });
    expect(loginOriginCovering("http://127.0.0.1:9999/", logins)).toEqual({
      origin: "http://127.0.0.1:4000",
    });
    expect(loginOriginCovering("https://notexample.com/", logins)).toBeNull();
    expect(loginOriginCovering("http://localhost:3000/", logins)).toBeNull();
    // Inherited-origin documents have no host to compare.
    expect(loginOriginCovering("about:blank", logins)).toBe("unknown");
    expect(loginOriginCovering("about:blank", [])).toBeNull();
  });

  describe("in-page guard", () => {
    const scopes = ["example.com", "127.0.0.1"];

    it("runs the script in global scope elsewhere", () => {
      const expression = guardedExpression("var leaked = 1; location.hostname", scopes);
      const globals: Record<string, unknown> = {};
      expect(runAt("http://localhost:3000/", expression, globals)).toBe("localhost");
      expect(globals.leaked).toBe(1);
      expect(runAt("https://notexample.com/", guardedExpression("1 + 1", scopes))).toBe(2);
    });

    it("refuses on the signed-in site before the script runs", () => {
      for (const url of [
        "https://example.com/",
        "https://app.example.com/",
        "https://example.com./",
        "http://127.0.0.1:5000/",
      ]) {
        const globals: Record<string, unknown> = {};
        expect(() =>
          runAt(url, guardedExpression("globalThis.ran = true", scopes), globals),
        ).toThrow(LOGIN_SCRIPT_REFUSED);
        expect(globals.ran).toBeUndefined();
      }
    });

    it("refuses documents with no http host", () => {
      expect(() => runAt("about:blank", guardedExpression("1", scopes))).toThrow(
        LOGIN_SCRIPT_REFUSED,
      );
    });

    it("does not trust prototype methods the page can replace", () => {
      const context = NodeVM.createContext({ location: new URL("https://app.example.com/") });
      NodeVM.runInContext(
        "String.prototype.endsWith = () => false; String.prototype.charCodeAt = () => 0;",
        context,
      );
      expect(() => NodeVM.runInContext(guardedExpression("1", scopes), context)).toThrow(
        LOGIN_SCRIPT_REFUSED,
      );
    });

    it("keeps the expression's own quoting intact", () => {
      expect(runAt("https://other.test/", guardedExpression('"a\\"b" + `c${1}`', scopes))).toBe(
        'a"bc1',
      );
    });
  });
});
