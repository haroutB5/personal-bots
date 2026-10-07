// Uncaught page errors and unhandled promise rejections fail the e2e smoke (Astra's review, 7 Oct: they used to
// be recorded and printed but never counted, so a journey that threw in the background still passed).
//
// ALLOWED_PAGE_ERRORS is the only way to let one through. Each entry needs:
//   pattern  an anchored RegExp (^...$) that matches the WHOLE first line of the error message, so it cannot
//            swallow a different error that merely contains the same words;
//   why      one sentence: why this error is expected in the hermetic suite and what would make it go away.
// The list started empty (7 Oct). Add an entry only for an error that a current run actually prints, with the exact
// text copied from that run, and say in the commit why it is harmless.
export const ALLOWED_PAGE_ERRORS = [
  {
    // Seen in the first journey of a 7 Oct run (bots-list-chat, cold page load). The suite blocks every origin except
    // the throwaway server on purpose (blockExternal in lib.mjs), so Clerk's script cannot load; the throwaway root
    // has no Clerk sign-in. On the real phone the script loads. A new Clerk major version changes the URL and fails
    // the run until someone looks, which is intended.
    pattern:
      /^e: Clerk: Failed to load Clerk JS, failed to load script: https:\/\/clerk\.t3\.codes\/npm\/@clerk\/clerk-js@6\/dist\/clerk\.browser\.js$/,
    why: "the suite blocks all network except the throwaway server, so Clerk JS cannot load (7 Oct run, bots-list-chat)",
  },
];

/** @returns {{ unexpected: string[], allowed: string[] }} */
export function splitPageErrors(errors, allowList = ALLOWED_PAGE_ERRORS) {
  const unexpected = [];
  const allowed = [];
  for (const message of errors) {
    const text = String(message);
    if (allowList.some((entry) => entry.pattern.test(text))) allowed.push(text);
    else unexpected.push(text);
  }
  return { unexpected, allowed };
}

/** The one-line failure for a journey, naming the journey and every unexpected error. */
export function describePageErrors(journeyId, unexpected) {
  const shown = unexpected.map((message) => JSON.stringify(message)).join(" | ");
  return `uncaught page error in journey "${journeyId}" (${unexpected.length}): ${shown}`;
}
