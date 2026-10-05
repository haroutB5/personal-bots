// 1.60.42 rebuild (Fable's review): negation, the date a bot stamps, trivial forms, and a request
// to drop a rule being about that rule.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  FORGET_REQUEST,
  forgetGrounding,
  negationCount,
  ruleGrounding,
  sentencesOfQuote,
} from "./memoryRule.ts";

describe("a rule may not say the opposite of what the owner said", () => {
  it("refuses a rule that leaves out a 'don't', and one that adds it", () => {
    const left = ruleGrounding("Use Codex for QA.", "Don't use Codex for QA.");
    expect(left.ok).toBe(false);
    expect(left.missing.join(" ")).toContain("no/not/never");
    const added = ruleGrounding("Don't use Codex for QA.", "Use Codex for QA.");
    expect(added.ok).toBe(false);
    expect(added.missing.join(" ")).toContain("did not say");
    for (const [rule, message] of [
      ["Use Codex for QA.", "Never use Codex for QA."],
      ["Use Codex for QA.", "Use Codex for QA, but not for Backend."],
      ["Reply with headings.", "Reply without headings."],
      ["Never use short replies.", "Always use short replies."],
      ["Always use short replies.", "Never use short replies."],
      ["Keep replies short.", "Keep replies short, no headings."],
      // QA's two live repros on 1.60.42.
      ["Delete real chats during tests.", "Never delete my real chats during tests."],
      ["Always deploy before QA passes.", "Never deploy before QA passes."],
    ] as const) {
      expect(ruleGrounding(rule, message).ok, `${message} -> ${rule}`).toBe(false);
    }
  });

  it("accepts the same meaning in other negation words", () => {
    for (const [message, rule] of [
      ["Never use emojis.", "Do not use emojis."],
      ["Never use emojis.", "No emojis."],
      ["Don't use emojis", "Never use emojis."],
      ["remember: no emojis in replies", "Don't use emojis in replies."],
      ["Reply without headings", "Do not use headings in replies."],
    ] as const) {
      const result = ruleGrounding(rule, message);
      expect(result.ok, `${message} -> ${rule}: ${result.missing.join(",")}`).toBe(true);
    }
  });

  it("a 'don't forget' that asks to remember is not a negation", () => {
    expect(negationCount("Don't forget the weekly report goes out on Fridays")).toBe(0);
    expect(negationCount("Remember that Harout prefers short replies")).toBe(0);
    expect(negationCount("Please do not forget to quote prices in USD, not in pounds")).toBe(1);
    expect(negationCount("Never use emojis and don't add headings")).toBe(2);
    expect(
      ruleGrounding(
        "The weekly report goes out on Fridays.",
        "don't forget the weekly report goes out on Fridays",
      ).ok,
    ).toBe(true);
  });

  it("a quote cut out of the owner's sentence is read with the whole sentence", () => {
    const message = "Don't use Codex for QA";
    // The quote is word for word in the message, but it leaves the "Don't" out.
    const cut = ruleGrounding("Use Codex for QA.", message, { quote: "use Codex for QA" });
    expect(cut.ok).toBe(false);
    // In a longer message only the sentences the quote sits in count.
    const long = "Use Codex for QA. Don't use Codex for Backend. Keep replies short.";
    expect(sentencesOfQuote("Use Codex for QA", long)).toBe("Use Codex for QA.");
    expect(ruleGrounding("Use Codex for QA.", long, { quote: "Use Codex for QA" }).ok).toBe(true);
    expect(
      ruleGrounding("Don't use Codex for Backend.", long, {
        quote: "Don't use Codex for Backend",
      }).ok,
    ).toBe(true);
    // Without the quote the whole message sets the count.
    expect(ruleGrounding("Use Codex for QA.", long).ok).toBe(false);
  });

  it("a merge carries no fewer negations than its most negated rule, nor more than all together", () => {
    const originals = "Never use emojis in replies. Do not put emojis in replies to Harout.";
    const bounds = { min: 1, max: 2 };
    expect(
      ruleGrounding("Never use emojis in replies to Harout.", originals, {
        strict: true,
        negations: bounds,
      }).ok,
    ).toBe(true);
    expect(
      ruleGrounding("Use emojis in replies to Harout.", originals, {
        strict: true,
        negations: bounds,
      }).ok,
    ).toBe(false);
    expect(
      ruleGrounding("Never, never use no emojis in replies to Harout.", originals, {
        strict: true,
        negations: bounds,
      }).ok,
    ).toBe(false);
  });
});

describe("the date a bot stamps, and trivial forms", () => {
  const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-05T12:00:00Z"));
  const message = "remember that coin prices go in USD";

  it("the prefix a bot dates a rule with, and today's date, are not the owner's to say", () => {
    expect(
      ruleGrounding("Harout's rule (2026-10-05): coin prices go in USD.", message, {
        strict: true,
        nowMs,
      }).ok,
    ).toBe(true);
    // A pattern, not a date check: the same rule dated on other days.
    expect(
      ruleGrounding(
        "Harout's rule (2026-09-29, restated 2026-10-01): coin prices go in USD.",
        message,
        { strict: true, nowMs },
      ).ok,
    ).toBe(true);
    // Today's date anywhere is fine; another date in the body is a number the owner did not say.
    expect(ruleGrounding("Coin prices go in USD (2026-10-05).", message, { nowMs }).ok).toBe(true);
    const other = ruleGrounding("Coin prices go in USD since 2026-09-01.", message, { nowMs });
    expect(other.ok).toBe(false);
    expect(other.missing).toEqual(expect.arrayContaining(["2026", "09", "01"]));
    // A prefix that is not a dated rule is just words.
    expect(
      ruleGrounding("Auditor note (2026-10-05): coin prices go in USD.", message, {
        strict: true,
        nowMs,
      }).ok,
    ).toBe(false);
  });

  it("node is node.js, but a different address is not", () => {
    const scripts = "remember to use node for the scripts";
    expect(ruleGrounding("Use node.js for the scripts.", scripts).ok).toBe(true);
    expect(ruleGrounding("Use deno.land for the scripts.", scripts).ok).toBe(false);
    expect(
      ruleGrounding("Use node.js for the scripts.", "remember to use bun for the scripts").ok,
    ).toBe(false);
  });
});

describe("a request to drop a rule is about that rule", () => {
  const rule = "Quote coin prices in USD.";

  it("'ignore' and 'cancel' are ordinary words, and 'don't forget' asks the opposite", () => {
    for (const text of [
      "ignore the noise in that thread",
      "cancel my subscription to the newsletter",
      "don't forget the USD rule",
      "do not forget the tea rule",
      "never remove the coin prices rule",
      "please don't delete the tea rule",
    ]) {
      expect(FORGET_REQUEST.test(text), text).toBe(false);
    }
    expect(FORGET_REQUEST.test("Forget the USD rule, but don't forget the tea one")).toBe(true);
  });

  it("names the rule by what it is about, or restates it", () => {
    for (const quote of [
      "forget the USD rule",
      "please remove the coin prices rule",
      "stop quoting coin prices in USD",
      "delete the rule about USD prices",
    ]) {
      expect(forgetGrounding(rule, quote), quote).toBe(true);
    }
  });

  it("not by a bare 'that rule', and not another rule", () => {
    for (const quote of [
      "forget that rule",
      "remove it",
      "forget the Codex rule",
      "forget the tea rule",
      "drop the thing about subscriptions",
    ]) {
      expect(forgetGrounding(rule, quote), quote).toBe(false);
    }
  });
});
