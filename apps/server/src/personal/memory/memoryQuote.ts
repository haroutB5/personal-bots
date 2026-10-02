/**
 * Whether a bot's quote of the owner is word for word in one of the owner's
 * messages. It only gates whether a bot may ask to change memory at all; it
 * never authorizes a change other bots see (that takes the owner's tap).
 */
const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();

/** The quote is word for word part of the message (case, spacing and punctuation aside). */
export function quoteInMessage(quote: string, message: string): boolean {
  const needle = normalise(quote);
  return needle.length > 0 && ` ${normalise(message)} `.includes(` ${needle} `);
}
