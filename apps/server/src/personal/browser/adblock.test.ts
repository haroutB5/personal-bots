import { describe, expect, it } from "vite-plus/test";

import {
  ADBLOCK_ENV_NAME,
  ADBLOCK_MAX_ARG_CHARS,
  adblockEnabled,
  adblockHostRulesArg,
  adblockLaunchArgs,
  makeAdblockCounter,
  makeHostMatcher,
} from "./adblock.ts";
import { ADBLOCK_HOST_PATTERNS } from "./adblockDomains.ts";

describe("ad blocking kill switch", () => {
  it("is on unless the environment turns it off", () => {
    expect(adblockEnabled({})).toBe(true);
    expect(adblockEnabled({ [ADBLOCK_ENV_NAME]: "on" })).toBe(true);
    expect(adblockEnabled({ [ADBLOCK_ENV_NAME]: "" })).toBe(true);
    for (const off of ["off", "OFF", " off ", "0", "false", "No"]) {
      expect(adblockEnabled({ [ADBLOCK_ENV_NAME]: off })).toBe(false);
    }
  });

  it("adds exactly one launch switch when on and none when off", () => {
    expect(adblockLaunchArgs({}, ["*.ads.example"])).toEqual([
      "--host-rules=MAP *.ads.example ^NOTFOUND",
    ]);
    expect(adblockLaunchArgs({ [ADBLOCK_ENV_NAME]: "off" }, ["*.ads.example"])).toEqual([]);
    expect(adblockLaunchArgs({}, [])).toEqual([]);
  });

  it("joins rules with commas", () => {
    expect(adblockHostRulesArg(["*.a.example", "b.example"])).toBe(
      "--host-rules=MAP *.a.example ^NOTFOUND,MAP b.example ^NOTFOUND",
    );
  });
});

describe("the shipped list", () => {
  it("fits on the Windows command line with room for Chrome's other switches", () => {
    expect(adblockHostRulesArg(ADBLOCK_HOST_PATTERNS).length).toBeLessThanOrEqual(
      ADBLOCK_MAX_ARG_CHARS,
    );
  });

  it("holds only plain host globs", () => {
    for (const pattern of ADBLOCK_HOST_PATTERNS) {
      expect(pattern).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    expect(new Set(ADBLOCK_HOST_PATTERNS).size).toBe(ADBLOCK_HOST_PATTERNS.length);
  });

  it("is not empty and does block the biggest ad networks", () => {
    const blocked = makeHostMatcher(ADBLOCK_HOST_PATTERNS);
    expect(ADBLOCK_HOST_PATTERNS.length).toBeGreaterThan(100);
    expect(blocked("securepubads.g.doubleclick.net")).toBe(true);
    expect(blocked("pagead2.googlesyndication.com")).toBe(true);
  });

  // Hosts that sign-in, checkout, CAPTCHA and consent flows depend on, and the sites the bots use.
  it("never blocks sign-in, payment, bot-protection, CAPTCHA, consent or the bots' own sites", () => {
    const blocked = makeHostMatcher(ADBLOCK_HOST_PATTERNS);
    const protectedHosts = [
      "www.google.com",
      "accounts.google.com",
      "www.gstatic.com",
      "fonts.googleapis.com",
      "www.recaptcha.net",
      "hcaptcha.com",
      "newassets.hcaptcha.com",
      "js.hcaptcha.com",
      "challenges.cloudflare.com",
      "cdnjs.cloudflare.com",
      "static.cloudflareinsights.com",
      "geo.captcha-delivery.com",
      "js.datadome.co",
      "client.px-cloud.net",
      "collector-pxabc.px-cloud.net",
      "js.stripe.com",
      "m.stripe.network",
      "www.paypal.com",
      "www.paypalobjects.com",
      "assets.braintreegateway.com",
      "h.online-metrix.net",
      "login.microsoftonline.com",
      "appleid.apple.com",
      "www.facebook.com",
      "connect.facebook.net",
      "www.ebay.co.uk",
      "signin.ebay.co.uk",
      "i.ebayimg.com",
      "ir.ebaystatic.com",
      "www.amazon.co.uk",
      "www.amazon.com",
      "m.media-amazon.com",
      "images-na.ssl-images-amazon.com",
      "www.vinted.co.uk",
      "www.vinted.com",
      "assets.vinted.net",
      "cdn.cookielaw.org",
      "geolocation.onetrust.com",
      "cdn.privacy-mgmt.com",
      "www.googletagmanager.com",
      "www.youtube.com",
      "i.ytimg.com",
      "d1234.cloudfront.net",
      "s3.eu-west-1.amazonaws.com",
      "cdn.jsdelivr.net",
      "localhost",
      "127.0.0.1",
    ];
    for (const host of protectedHosts) expect(blocked(host), host).toBe(false);
  });
});

describe("ad blocking counter", () => {
  const patterns = ["*.ads.example", "tracker.example"];

  it("counts a request that failed to resolve a listed host as blocked", () => {
    const counter = makeAdblockCounter(patterns);
    counter.request();
    counter.request();
    counter.request();
    counter.failed("https://x.ads.example/p.gif?id=7", "net::ERR_NAME_NOT_RESOLVED");
    counter.failed("https://tracker.example/t.js", "net::ERR_NAME_NOT_RESOLVED");
    expect(counter.snapshot()).toEqual({ enabled: true, rules: 2, requests: 3, blocked: 2 });
  });

  it("does not count other failures or hosts that are not listed", () => {
    const counter = makeAdblockCounter(patterns);
    counter.failed("https://x.ads.example/p.gif", "net::ERR_CONNECTION_RESET");
    counter.failed("https://other.example/p.gif", "net::ERR_NAME_NOT_RESOLVED");
    counter.failed("https://ads.example/", "net::ERR_NAME_NOT_RESOLVED");
    counter.failed("https://notads.example/", "net::ERR_NAME_NOT_RESOLVED");
    counter.failed("not a url", "net::ERR_NAME_NOT_RESOLVED");
    expect(counter.snapshot().blocked).toBe(0);
  });

  it("reports the kill switch as off without counting blocks", () => {
    const counter = makeAdblockCounter(patterns, false);
    counter.request();
    counter.failed("https://x.ads.example/p.gif", "net::ERR_NAME_NOT_RESOLVED");
    expect(counter.snapshot()).toEqual({ enabled: false, rules: 0, requests: 1, blocked: 0 });
  });

  it("keeps numbers only, never a URL", () => {
    const counter = makeAdblockCounter(patterns);
    counter.failed("https://x.ads.example/p.gif?email=a@b.c", "net::ERR_NAME_NOT_RESOLVED");
    expect(JSON.stringify(counter.snapshot())).not.toMatch(/example|email|http/);
  });
});
