// Generic cookie-consent accepter used identically before and after: it clicks the visible
// "accept" button of the common consent platforms, in the page or in any frame.
const TEXT =
  /^(accept all( cookies)?|accept( cookies)?|accept & continue|accept and continue|accept & close|agree|i agree|agree & continue|agree and proceed|allow all( cookies)?|allow cookies|ok|okay|got it|yes,? i('| a)m happy|i accept|continue)$/i;
const SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#didomi-notice-agree-button",
  ".fc-cta-consent",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#truste-consent-button",
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  'button[data-testid="accept-all"]',
  "#accept-all-cookies",
  "button#accept",
  '[data-cy="accept-all"]',
  "button.sp_choice_type_11",
  'button[title="Accept all"]',
  'button[title="Accept All"]',
  'button[title="ACCEPT ALL"]',
  'button[title="Accept"]',
  'button[title="I Accept"]',
  'button[title="Agree"]',
  'button[title="AGREE"]',
];
export async function acceptConsent(page, ms = 6000) {
  const end = Date.now() + ms;
  let clicked = null;
  while (Date.now() < end && !clicked) {
    for (const frame of page.frames()) {
      try {
        for (const sel of SELECTORS) {
          const el = frame.locator(sel).first();
          if ((await el.count()) && (await el.isVisible())) {
            await el.click({ timeout: 1500 });
            clicked = sel;
            break;
          }
        }
        if (clicked) break;
        const r = await frame
          .evaluate((src) => {
            const re = new RegExp(src, "i");
            for (const b of document.querySelectorAll(
              "button,[role=button],a.button,input[type=button]",
            )) {
              const t = (b.innerText || b.value || "").trim().replace(/\s+/g, " ");
              const box = b.getBoundingClientRect();
              if (
                t &&
                t.length < 40 &&
                re.test(t) &&
                box.width > 30 &&
                box.height > 15 &&
                getComputedStyle(b).visibility !== "hidden"
              ) {
                b.click();
                return t;
              }
            }
            return null;
          }, TEXT.source)
          .catch(() => null);
        if (r) {
          clicked = "text:" + r;
          break;
        }
      } catch {}
    }
    if (!clicked) await new Promise((r) => setTimeout(r, 500));
  }
  return clicked;
}
