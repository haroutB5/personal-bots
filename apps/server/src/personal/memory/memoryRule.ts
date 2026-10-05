/**
 * Whether a rule a bot wants to save comes from the owner's own message.
 *
 * Since 1.60.42 a rule the owner states in a chat they started is saved at
 * once, with no card to read first (memoryAutoApply.ts). The quote the bot hands
 * in (`userRequest`) only proves the owner said something; the rule's text is
 * the bot's. So the words are compared: a rule whose substance is not in the
 * owner's message is refused, not queued. This is a lexical check, on purpose
 * (no model, so a web page cannot talk it round): the rule's significant words
 * must be mostly the message's, every address, link, number and path in the
 * rule must be in the message word for word, and the rule must say "no", "not",
 * "never", "don't" and "without" as many times as the owner's words do, each one
 * about the same thing (a rule with the same words and the opposite meaning is the cheapest
 * forgery, and moving a "never" from "delete" to "asking" keeps the count).
 */
import * as DateTime from "effect/DateTime";

import { normalise } from "./memoryQuote.ts";

const STOP = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these they this to up us was we were what when where which who why will with would you your also just very only all any more most some such each every use used using make made want wants like likes prefer prefers preferred remember keep mind note save future reference user users owner".split(
    " ",
  ),
);

/**
 * Words that turn a rule round. They are not compared as words (a rule may say
 * "do not" where the owner said "no"); they are counted instead.
 */
const NEGATION_WORD =
  /^(?:no|not|never|without|nothing|none|neither|nor|nobody|cannot|dont|doesnt|didnt|wont|cant|shouldnt|isnt|arent|wasnt|werent|[\p{L}]+n't)$/u;

/** "Remember that", "don't forget to", "keep in mind": asks to keep a rule, says nothing about it. */
const REMEMBER_PHRASE =
  /\b(?:please\s+)?(?:remember(?:\s+(?:that|to))?|(?:don'?t|do not)\s+forget(?:\s+(?:that|to))?|keep in mind(?:\s+that)?|memori[sz]e(?:\s+that)?|note\s+(?:this|that|it)\s+down|save\s+(?:this|that|it)|for future reference)\b/giu;

/**
 * The date a bot stamps on a rule it writes: "Harout's rule (2026-10-05): ...". One or two
 * name words, "rule(s)", and a bracket holding a date, at most one of restated / updated /
 * clarified / confirmed and one more date. Nothing else in the bracket is exempt, so a link
 * or a number tucked in there is checked like the rest of the rule.
 */
const RULE_DATE_PREFIX =
  /^\s*[\p{L}'’]+(?:\s+[\p{L}'’]+)?\s+rules?\s*\(\s*\d{4}-\d{2}-\d{2}(?:[,;\s]+(?:restated|updated|clarified|confirmed)(?:\s+\d{4}-\d{2}-\d{2})?)?\s*\)\s*[:\-–—]?\s*/iu;

/** Whose rules these are: a request to drop "the Harout rule" names no rule. */
const OWNER_NAME_WORDS = new Set(["harout"]);

/** Share of the rule's significant words that must be in the message. */
export const RULE_WORDS_IN_MESSAGE = 0.6;
/** The same, in a turn that had already read web pages (a page can steer the wording). */
export const RULE_WORDS_IN_MESSAGE_AFTER_WEB = 0.85;

const WORD = /[\p{L}][\p{L}'-]*/gu;
const URL_LIKE = /\bhttps?:\/\/[^\s)>\]"']+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,24})(?:\/[^\s)>\]"']*)?\b/gi;
const HANDLE = /(?:^|\s)@[\w.-]+/g;
const PATH = /(?:[a-z]:)?(?:[\\/][\w.@~-]+){2,}|~\/[\w./-]+/gi;
const NUMBER = /\d[\d.,]*\d|\d/g;
/** A word of letters and digits mixed (an id, a version, a model name). */
const MIXED = /\b(?=[a-z0-9._-]*\d)(?=[a-z0-9._-]*[a-z])[a-z0-9._-]{3,}\b/gi;
/** `node` for `node.js`: a file-type tail on a name is not an address to invent. */
const NAME_TAIL = /\.(?:js|ts|jsx|tsx|py|rb|go|rs|cs|sh|md|json)$/;

const lower = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'");

const digitsOnly = (text: string) => text.replace(/\D/g, "");

/** A crude stem: enough that reply, replies and replying meet. */
function stem(word: string): string {
  const w = word.replace(/'s?$/, "");
  if (w.length <= 4) return w;
  const stemmed = w.replace(/(?:ingly|edly|ing|ied|ies|ed|es|ly|s)$/, (suffix) =>
    suffix === "ies" || suffix === "ied" ? "y" : "",
  );
  // "reply" is not "rep": a stem that short is the word itself.
  return stemmed.length < 4 ? w : stemmed;
}

/** Words of two stems are one when they are equal or share all but their last letter (min 4). */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= Math.max(4, Math.min(a.length, b.length) - 1);
}

/**
 * The lower-case word if it carries meaning, else null. Two-letter words count when written
 * in capitals (QA, UI, US: a rule about "QA" is not one about "Backend"). With `pool`, every
 * two-letter word counts, for the owner's side of a comparison: "qa" in their message meets
 * "QA" in the rule.
 */
function significantWord(match: string, pool: boolean): string | null {
  const raw = match.replace(/'s?$/i, "");
  const word = match.toLowerCase();
  if (NEGATION_WORD.test(word)) return null;
  if (word.length >= 3 && !STOP.has(word)) return word;
  const twoLetter = raw.length === 2;
  const capitals = twoLetter && raw === raw.toUpperCase() && raw !== raw.toLowerCase();
  return capitals || (pool && twoLetter) ? word : null;
}

const plainWords = (text: string) => text.normalize("NFKC").replace(/[‘’]/g, "'");

const significantStems = (text: string, pool = false): ReadonlyArray<string> =>
  [...plainWords(text).matchAll(WORD)].flatMap((match) => {
    const word = significantWord(match[0], pool);
    return word === null ? [] : [stem(word)];
  });

const LOCAL_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD for the server's own day and for UTC: a bot may stamp either. */
const todayStamps = (nowMs: number): ReadonlyArray<string> => [
  ...new Set([
    LOCAL_DAY.format(nowMs),
    DateTime.formatIso(DateTime.makeUnsafe(nowMs)).slice(0, 10),
  ]),
];

/** A rule's text as the grounding reads it: without the date prefix a bot stamps and without today's date. */
function ruleBody(content: string, nowMs: number | undefined): string {
  let body = content.replace(RULE_DATE_PREFIX, " ");
  if (nowMs !== undefined)
    for (const stamp of todayStamps(nowMs)) body = body.replaceAll(stamp, " ");
  return body;
}

/** Links, addresses, handles, paths, numbers and ids: what a rule may not invent. */
function exactTokens(text: string): ReadonlyArray<string> {
  const flat = lower(text);
  const found = new Set<string>();
  for (const pattern of [URL_LIKE, EMAIL, HANDLE, PATH, MIXED, DOMAIN]) {
    for (const match of flat.matchAll(pattern)) {
      const token = match[0].trim().replace(/[.,;:!?]+$/, "");
      if (token.length > 0) found.add(token);
    }
  }
  for (const match of flat.matchAll(NUMBER)) {
    const digits = digitsOnly(match[0]);
    if (digits.length > 0) found.add(`#${digits}`);
  }
  return [...found];
}

/** How many times a text says no, not, never, don't, without (a remember phrase aside). */
export const negationCount = (text: string): number => negationsOf(text).length;

/** One "no", "not", "never", "don't" or "without", and the first meaningful word after it. */
export interface Negation {
  /** The word as written, lower case. */
  readonly word: string;
  /** "without" only matches "without"; no, not, never, don't and the rest are one group. */
  readonly kind: "without" | "not";
  /** The stem of the next significant word in the same sentence; null when there is none. */
  readonly scope: string | null;
}

const NEGATION_TOKENS = /[\p{L}][\p{L}'-]*|[.;!?\n]/gu;

/**
 * Every negation in a text with what it is about: the next significant word, up to the end
 * of the sentence. "Never delete my real chats" is `never` about `delete`; "Delete real chats
 * without asking" is `without` about `ask`. A remember phrase aside, as in `negationCount`.
 */
export function negationsOf(text: string): ReadonlyArray<Negation> {
  const tokens = [...plainWords(text.replace(REMEMBER_PHRASE, " ")).matchAll(NEGATION_TOKENS)].map(
    (match) => match[0],
  );
  const found: Array<Negation> = [];
  tokens.forEach((token, index) => {
    const word = token.toLowerCase();
    if (!NEGATION_WORD.test(word)) return;
    let scope: string | null = null;
    for (let next = index + 1; next < tokens.length; next++) {
      const candidate = tokens[next]!;
      if (/^[.;!?\n]$/.test(candidate)) break;
      const meaningful = significantWord(candidate, false);
      if (meaningful !== null) {
        scope = stem(meaningful);
        break;
      }
    }
    found.push({ word, kind: word === "without" ? "without" : "not", scope });
  });
  return found;
}

const sameNegation = (a: Negation, b: Negation) =>
  a.kind === b.kind &&
  (a.scope === null || b.scope === null ? a.scope === b.scope : sameStem(a.scope, b.scope));

const showNegation = (negation: Negation) =>
  negation.scope === null ? `"${negation.word}"` : `"${negation.word} ... ${negation.scope}"`;

/**
 * Pairs each of `left` with a different one of `right` that says the same (the same kind of
 * negation about the same thing). The ones of `left` left over have no pair in `right`.
 */
function unpaired(
  left: ReadonlyArray<Negation>,
  right: ReadonlyArray<Negation>,
): ReadonlyArray<Negation> {
  const free = [...right];
  const rest: Array<Negation> = [];
  for (const negation of left) {
    const at = free.findIndex((candidate) => sameNegation(negation, candidate));
    if (at === -1) rest.push(negation);
    else free.splice(at, 1);
  }
  return rest;
}

/**
 * The sentences of `message` the `quote` sits in: the part of the owner's message that
 * says what the rule is. A quote cut from the middle of "Don't use X" is still read with
 * the "Don't". The whole message when the quote cannot be placed.
 */
export function sentencesOfQuote(quote: string, message: string): string {
  const needle = normalise(quote);
  if (needle.length === 0) return message;
  const sentences = message
    .split(/(?<=[.!?;])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const normalised = sentences.map(normalise);
  for (let length = 1; length <= sentences.length; length++) {
    for (let start = 0; start + length <= sentences.length; start++) {
      if (` ${normalised.slice(start, start + length).join(" ")} `.includes(` ${needle} `)) {
        return sentences.slice(start, start + length).join(" ");
      }
    }
  }
  return message;
}

export interface RuleGrounding {
  readonly ok: boolean;
  /** What is not the owner's, for the bot's refusal (empty when ok). */
  readonly missing: ReadonlyArray<string>;
  readonly coverage: number;
}

export interface RuleGroundingOptions {
  /** A turn that had read web pages: the wording is held closer. */
  readonly strict?: boolean;
  /**
   * The words the bot quoted. The rule's negations are compared with those of the
   * sentences of `message` it sits in; without it, with the whole message.
   */
  readonly quote?: string;
  /** How many negations the rule may carry, when the message's count is not the measure (a merge). */
  readonly negations?: { readonly min: number; readonly max: number };
  /** Today as epoch milliseconds, for the date a bot stamps on a rule (without it, only the dated prefix is exempt). */
  readonly nowMs?: number;
}

/**
 * Compares a rule's text with the owner's message. `strict` is for a turn that
 * had read web pages. A rule with no significant word (all stop words) is not
 * grounded: there is nothing of the owner's in it to check.
 */
export function ruleGrounding(
  content: string,
  message: string,
  options: RuleGroundingOptions = {},
): RuleGrounding {
  const wanted = options.strict === true ? RULE_WORDS_IN_MESSAGE_AFTER_WEB : RULE_WORDS_IN_MESSAGE;
  const body = ruleBody(content, options.nowMs);
  const flatMessage = lower(message);
  const messageStems = significantStems(message, true);
  const ownerDigits = new Set([...flatMessage.matchAll(NUMBER)].map((m) => `#${digitsOnly(m[0])}`));
  const missing: Array<string> = [];

  for (const token of exactTokens(body)) {
    if (token.startsWith("#")) {
      if (!ownerDigits.has(token)) missing.push(token.slice(1));
    } else if (
      !flatMessage.includes(token) &&
      !flatMessage.includes(token.replace(NAME_TAIL, ""))
    ) {
      missing.push(token);
    }
  }

  const words = significantStems(body);
  const unique = [...new Set(words)];
  const inMessage = unique.filter((word) => messageStems.some((owned) => sameStem(word, owned)));
  for (const word of unique) {
    if (!inMessage.includes(word)) missing.push(word);
  }
  const coverage = unique.length === 0 ? 0 : inMessage.length / unique.length;
  const hasTokenGap = missing.some((word) => !unique.includes(word));

  // The meaning must not turn round: the same "no/not/never/don't/without" the owner said, each
  // about the same thing, and no others. Moving a "never" from one action to another keeps the
  // count and makes the opposite rule, so each is paired with the owner's by what it is about.
  const ruleNegations = negationsOf(body);
  const ownerNegations = negationsOf(
    options.quote === undefined ? message : sentencesOfQuote(options.quote, message),
  );
  const bounds = options.negations ?? {
    min: ownerNegations.length,
    max: ownerNegations.length,
  };
  // The rule's that the owner did not say, and (unless the rule is a merge of several rules,
  // which may say each thing once) the owner's that the rule left out.
  const invented = unpaired(ruleNegations, ownerNegations);
  const dropped = options.negations === undefined ? unpaired(ownerNegations, ruleNegations) : [];
  const countOk = ruleNegations.length >= bounds.min && ruleNegations.length <= bounds.max;
  const negationsOk = countOk && invented.length === 0 && dropped.length === 0;
  if (!countOk) {
    missing.push(
      ruleNegations.length < bounds.min
        ? `the user's "no/not/never/don't/without" (${bounds.min}), which the rule leaves out`
        : `a "no/not/never/don't/without" the user did not say (the rule has ${ruleNegations.length}, they said ${bounds.max})`,
    );
  }
  for (const negation of invented) {
    missing.push(`${showNegation(negation)} in the rule, which the user did not say about that`);
  }
  for (const negation of dropped) {
    missing.push(`the user's ${showNegation(negation)}, which the rule does not say about that`);
  }
  return {
    ok: unique.length > 0 && coverage >= wanted && !hasTokenGap && negationsOk,
    missing: missing.slice(0, 8),
    coverage,
  };
}

/** Whether a rule on `subject` is about the same thing as `other`: they share a significant word. */
export function sharesSubject(subject: string, other: string): boolean {
  const left = significantStems(subject);
  const right = significantStems(other, true);
  return left.some((word) => right.some((owned) => sameStem(word, owned)));
}

/**
 * Words that ask for something to be dropped. "Don't forget" / "never remove" ask the opposite.
 * ("ignore" and "cancel" are not here: they are ordinary words about other things.)
 */
export const FORGET_REQUEST =
  /(?<!\b(?:don'?t|do not|never|not)\s+)\b(?:forget|remove|delete|drop|discard|scrap|retire)\b|\b(?:stop (?:following|using|applying)|no longer|not anymore|don'?t (?:follow|use|apply))\b/i;

/** Words of a request to drop a rule that say nothing about which rule. */
const FORGET_FILLER = new Set([
  "forget",
  "remove",
  "delete",
  "drop",
  "discard",
  "scrap",
  "retire",
  "rule",
  "rules",
  "preference",
  "preferences",
  "instruction",
  "instructions",
  "memory",
  "memories",
  "thing",
  "stuff",
  "anymore",
  "longer",
  "following",
  "follow",
  "applying",
  "apply",
  "applies",
  "using",
  "stop",
  "about",
  "that",
  "this",
  "old",
]);

/**
 * Whether the owner's words, asking to drop a rule, are about this rule. They are when the
 * rule's own words are in them (they restated it), or when what they name is in the rule:
 * "forget the USD rule" names "usd", and the rule is about USD. "Forget that rule" names
 * nothing, and a quote that names words the rule does not have is about something else.
 */
export function forgetGrounding(ruleContent: string, quote: string, nowMs?: number): boolean {
  if (ruleGrounding(ruleContent, quote, nowMs === undefined ? { quote } : { quote, nowMs }).ok)
    return true;
  const named = [...new Set(significantStems(quote))].filter(
    (word) => !FORGET_FILLER.has(word) && !OWNER_NAME_WORDS.has(word),
  );
  if (named.length === 0) return false;
  // The rule as its words are, not the "Harout's rule (date):" a bot stamped on it.
  const rule = significantStems(ruleBody(ruleContent, nowMs), true);
  const found = named.filter((word) => rule.some((owned) => sameStem(word, owned)));
  return found.length / named.length >= RULE_WORDS_IN_MESSAGE;
}
