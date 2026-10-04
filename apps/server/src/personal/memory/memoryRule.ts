/**
 * Whether a rule a bot wants to save comes from the owner's own message.
 *
 * Since 1.60.42 a rule the owner states in a chat they started is saved at
 * once, with no card to read first (memoryAutoApply.ts). The quote the bot hands
 * in (`userRequest`) only proves the owner said something; the rule's text is
 * the bot's. So the words are compared: a rule whose substance is not in the
 * owner's message is refused, not queued. This is a lexical check, on purpose
 * (no model, so a web page cannot talk it round): the rule's significant words
 * must be mostly the message's, and every address, link, number and path in the
 * rule must be in the message word for word.
 */

const STOP = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my no not of on or our please should so than that the their them then there these they this to up us was we were what when where which who why will with would you your always never also just very only all any more most some such any each every use used using make made want wants like likes prefer prefers preferred remember keep mind note save future reference user users owner".split(
    " ",
  ),
);

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
  return w.replace(/(?:ingly|edly|ing|ied|ies|ed|es|ly|s)$/, (suffix) =>
    suffix === "ies" || suffix === "ied" ? "y" : "",
  );
}

/** Words of two stems are one when they are equal or share all but their last letter (min 4). */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= Math.max(4, Math.min(a.length, b.length) - 1);
}

const significantStems = (text: string): ReadonlyArray<string> =>
  [...lower(text).matchAll(WORD)]
    .map((match) => match[0])
    .filter((word) => word.length >= 3 && !STOP.has(word))
    .map(stem);

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

export interface RuleGrounding {
  readonly ok: boolean;
  /** What is not the owner's, for the bot's refusal (empty when ok). */
  readonly missing: ReadonlyArray<string>;
  readonly coverage: number;
}

/**
 * Compares a rule's text with the owner's message. `strict` is for a turn that
 * had read web pages. A rule with no significant word (all stop words) is not
 * grounded: there is nothing of the owner's in it to check.
 */
export function ruleGrounding(
  content: string,
  message: string,
  options: { readonly strict?: boolean } = {},
): RuleGrounding {
  const wanted = options.strict === true ? RULE_WORDS_IN_MESSAGE_AFTER_WEB : RULE_WORDS_IN_MESSAGE;
  const flatMessage = lower(message);
  const messageStems = significantStems(message);
  const ownerDigits = new Set([...flatMessage.matchAll(NUMBER)].map((m) => `#${digitsOnly(m[0])}`));
  const missing: Array<string> = [];

  for (const token of exactTokens(content)) {
    if (token.startsWith("#")) {
      if (!ownerDigits.has(token)) missing.push(token.slice(1));
    } else if (!flatMessage.includes(token)) {
      missing.push(token);
    }
  }

  const words = significantStems(content);
  const unique = [...new Set(words)];
  const inMessage = unique.filter((word) => messageStems.some((owned) => sameStem(word, owned)));
  for (const word of unique) {
    if (!inMessage.includes(word)) missing.push(word);
  }
  const coverage = unique.length === 0 ? 0 : inMessage.length / unique.length;
  const hasTokenGap = missing.some((word) => !unique.includes(word));
  return {
    ok: unique.length > 0 && coverage >= wanted && !hasTokenGap,
    missing: missing.slice(0, 8),
    coverage,
  };
}

/** Whether a rule on `subject` is about the same thing as `other`: they share a significant word. */
export function sharesSubject(subject: string, other: string): boolean {
  const left = significantStems(subject);
  const right = significantStems(other);
  return left.some((word) => right.some((owned) => sameStem(word, owned)));
}

/** Words that ask for something to be dropped. */
export const FORGET_REQUEST =
  /\b(forget|remove|delete|drop|discard|stop (?:following|using|applying)|no longer|not anymore|don'?t (?:follow|use|apply)|ignore|scrap|retire|cancel)\b/i;
