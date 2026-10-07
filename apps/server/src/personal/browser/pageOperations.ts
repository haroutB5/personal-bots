/**
 * Preview-automation operations over a {@link BrowserPage}. Logic mirrors the
 * desktop host (`apps/desktop/src/preview/Manager.ts` snapshot/click/type) but
 * uses Playwright locators directly instead of injected selector engines.
 */
// @effect-diagnostics globalTimers:off -- performEvaluate races a non-Effect Playwright promise against a plain timer and clears it in `finally` on every path.
import type {
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationDragInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHistoryInput,
  PreviewAutomationHoverInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";

import type { BrowserPage, PointerClickOptions } from "./driver.ts";

/** A failure the host reports back to the broker with a known remote tag. */
export class HostOperationError extends Error {
  readonly tag: string;
  readonly detail: unknown;

  constructor(tag: string, message: string, detail?: unknown) {
    super(message);
    this.tag = tag;
    this.detail = detail;
  }
}

const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_INTERACTIVE_ELEMENT_NAME_LENGTH = 200;

const SNAPSHOT_SCRIPT = `(() => {
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute);
      if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === current.tagName) : [];
      const base = current.tagName.toLowerCase();
      parts.unshift(siblings.length > 1 ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : base);
      current = parent;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]"))
    .filter(visible)
    .slice(0, ${MAX_INTERACTIVE_ELEMENTS})
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: (element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "").slice(0, ${MAX_INTERACTIVE_ELEMENT_NAME_LENGTH}),
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    });
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
    interactiveElements: elements
  };
})()`;

/** Inputs that may target an element; both fields are optional in every op schema. */
export interface SelectorInput {
  readonly locator?: string | undefined;
  readonly selector?: string | undefined;
}

const firstLine = (message: string) =>
  message.split("\n")[0]?.trim() || "Browser operation failed.";

const selectorDetail = (input: SelectorInput) =>
  input.locator !== undefined
    ? { selectorKind: "locator" as const, selectorLength: input.locator.length }
    : input.selector !== undefined
      ? { selectorKind: "selector" as const, selectorLength: input.selector.length }
      : undefined;

/**
 * What a failed page load says, in plain words: Chrome's network error codes and Playwright's
 * "page.goto: ..." prefix mean nothing to a person (or to a model deciding what to do next).
 * The code stays at the end in brackets for diagnosis; the address (which can carry a token in
 * its query) and Playwright's call log are dropped. Null when the message is not a navigation
 * failure, so every other operation keeps its own wording.
 */
const NETWORK_ERROR_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /NAME_NOT_RESOLVED|NAME_RESOLUTION|DNS_/,
    "That site's address could not be found. Check how the web address is spelled.",
  ],
  [
    /INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED/,
    "The computer running the browser has no internet connection right now.",
  ],
  [/CONNECTION_REFUSED/, "The site refused the connection: nothing is answering at that address."],
  [
    /ADDRESS_UNREACHABLE|ADDRESS_INVALID/,
    "That site's address can't be reached from this computer.",
  ],
  [/CONNECTION_TIMED_OUT|TIMED_OUT/, "The site took too long to answer."],
  [
    /CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|EMPTY_RESPONSE|HTTP2_|QUIC_|SOCKET_NOT_CONNECTED/,
    "The connection to the site dropped before it answered. Trying again often works.",
  ],
  [
    /CERT_|SSL_|BAD_SSL/,
    "The site's security certificate could not be trusted, so the page was not opened.",
  ],
  [/TOO_MANY_REDIRECTS/, "The site keeps redirecting in a loop."],
  [
    /ABORTED/,
    "The page load was interrupted: a newer navigation replaced it, or the link is a download.",
  ],
  [/BLOCKED_BY|ACCESS_DENIED/, "The site refused to be opened in this browser."],
  [/INVALID_URL|UNSAFE_PORT/, "That web address is not valid or uses a port the browser blocks."],
];

const NAVIGATION_CALL = /^(?:page|frame)\.(?:goto|reload|goBack|goForward|waitForURL)\b/;

const PAGE_NOT_OPENED = "The page could not be opened.";

export function friendlyNavigationMessage(message: string): string | null {
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1];
  if (code !== undefined) {
    const words = NETWORK_ERROR_WORDS.find(([pattern]) => pattern.test(code))?.[1];
    return `${words ?? PAGE_NOT_OPENED} (${code})`;
  }
  if (NAVIGATION_CALL.test(message)) {
    const limit = /Timeout (\d+)ms exceeded/.exec(message)?.[1];
    if (limit !== undefined) {
      const seconds = Math.max(1, Math.round(Number(limit) / 1_000));
      return `The page took longer than ${seconds} s to load. It may still be loading; try again or open something lighter.`;
    }
    // No network code and no timeout ("interrupted by another navigation", "page was closed"):
    // Playwright's text carries the address, which can hold a token, and means nothing to a person.
    return PAGE_NOT_OPENED;
  }
  return null;
}

/**
 * A navigation Chrome replaced with another one ("interrupted by another navigation to ..."), as
 * when a site redirects to a /sorry or challenge page. That is not a failure to load: the other
 * navigation may have landed.
 */
export function isReplacedNavigation(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    NAVIGATION_CALL.test(message) &&
    !/net::ERR_/.test(message) &&
    /interrupted by another navigation/i.test(message)
  );
}

/**
 * A page that stops a bot and asks for proof of a human (a challenge, a captcha, a block page).
 * Landing on one is the most common reason a browsing task stalls, so the server logs which
 * origins do it. The probe runs in the page and hands back only a short lower-cased sample of the
 * title and the top of the visible text plus the kinds of challenge frames present; the host
 * classifies it, and nothing from the sample is logged.
 */
export const BOT_CHECK_PROBE = `(() => {
  const frames = Array.from(document.querySelectorAll("iframe[src]"))
    .map((frame) => frame.getAttribute("src") || "")
    .filter((src) => /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|captcha-delivery|px-cdn|arkoselabs|funcaptcha/i.test(src));
  const marked = Boolean(document.querySelector("#challenge-form, #cf-challenge-running, .g-recaptcha, .h-captcha, #px-captcha, [data-sitekey]"));
  return {
    title: (document.title || "").slice(0, 120).toLowerCase(),
    text: (document.body?.innerText || "").slice(0, 500).toLowerCase(),
    frames: frames.length,
    marked,
  };
})()`;

export type BotCheckKind = "challenge" | "captcha" | "blocked";

export function classifyBotCheck(sample: unknown): BotCheckKind | null {
  if (typeof sample !== "object" || sample === null) return null;
  const { title, text, frames, marked } = sample as Record<string, unknown>;
  const heading = typeof title === "string" ? title : "";
  const body = typeof text === "string" ? text : "";
  const both = `${heading}\n${body}`;
  if (
    /^just a moment|^attention required|checking your browser|checking if the site connection is secure|verifying you are human|performing security verification/.test(
      both,
    )
  ) {
    return "challenge";
  }
  if (
    (typeof frames === "number" && frames > 0) ||
    marked === true ||
    /captcha|verify (?:that )?you are (?:a )?human|are you a robot|i'm not a robot|confirm you are human|press (?:&|and) hold/.test(
      both,
    )
  ) {
    return "captcha";
  }
  if (
    /unusual traffic|access denied|request blocked|you have been blocked|automated (?:access|requests)|bot detected|pardon our interruption/.test(
      both,
    )
  ) {
    return "blocked";
  }
  return null;
}

/** Maps Playwright failures onto the error tags the broker classifies. */
export function classifyPageError(cause: unknown, input: SelectorInput = {}): HostOperationError {
  if (cause instanceof HostOperationError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";
  const friendly = friendlyNavigationMessage(message);
  if (name === "TimeoutError" || /Timeout \d+ms exceeded/.test(message)) {
    return new HostOperationError("PreviewAutomationTimeoutError", friendly ?? firstLine(message));
  }
  // The tab going away stays its own tag, with the plain wording when it was a navigation.
  if (/has been closed|Target closed|Target page/i.test(message)) {
    return new HostOperationError(
      "PreviewAutomationTabNotFoundError",
      friendly ?? firstLine(message),
    );
  }
  if (friendly !== null) return new HostOperationError("PreviewAutomationExecutionError", friendly);
  if (
    /while parsing (css )?selector|Unexpected token|Unknown engine|is not a valid selector/i.test(
      message,
    )
  ) {
    return new HostOperationError(
      "PreviewAutomationInvalidSelectorError",
      firstLine(message),
      selectorDetail(input),
    );
  }
  if (/not an <input>|is not editable|not an editable/i.test(message)) {
    return new HostOperationError(
      "PreviewAutomationTargetNotEditableError",
      firstLine(message),
      selectorDetail(input) ?? { selectorKind: "focused-element" },
    );
  }
  return new HostOperationError("PreviewAutomationExecutionError", firstLine(message));
}

const locatorOf = (input: SelectorInput) => input.locator ?? input.selector ?? null;

const LOGIN_PASSWORD_INPUT = 'input[type="password"]:visible:not([disabled])';
const LOGIN_USERNAME_INPUTS = [
  'input[autocomplete="username"]:visible:not([disabled])',
  'input[type="email"]:visible:not([disabled])',
  'input[name*="user" i]:visible:not([disabled])',
  'input[name*="email" i]:visible:not([disabled])',
  'input[name*="login" i]:visible:not([disabled])',
  'input[type="text"]:visible:not([disabled])',
] as const;

export type PersonalLoginFilledField = "username" | "password";

const pageOrigin = (page: BrowserPage, expectedOrigin: string) => {
  let currentOrigin: string;
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `This saved login can only be used on ${expectedOrigin}. The current page has no valid origin.`,
    );
  }
  if (currentOrigin !== expectedOrigin) {
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `This saved login can only be used on ${expectedOrigin}; the current page origin is ${currentOrigin}.`,
    );
  }
};

/** The password fill gets a short window of its own; `timeoutMs` covers discovery. */
const PASSWORD_FILL_TIMEOUT_MS = 2_000;

/**
 * Where the login form would actually submit, resolved by the browser rather
 * than read off an attribute.
 *
 * `form.action` and `element.formAction` are IDL attributes: the browser has
 * already resolved them against `document.baseURI` and normalized the scheme,
 * so uppercase schemes, leading whitespace, a protocol-relative `//host/…` and
 * a relative action under a cross-origin `<base>` all arrive here as absolute
 * URLs. Attribute-prefix matching saw none of those.
 *
 * The form is selected the same way the fill selects it — the visible, enabled
 * password field, preferring the form that holds the focus — so what is
 * validated is what is filled.
 */
const formDestinationsScript = (fieldSelector: string) => `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const fields = Array.from(document.querySelectorAll('${fieldSelector}'))
    .filter((element) => !element.disabled && visible(element));
  if (fields.length === 0) return { found: false, hasForm: false, baseUri: document.baseURI, action: null, submitters: [] };
  const focused = fields.find((element) => element.form !== null && element.form.contains(document.activeElement));
  const form = (focused ?? fields[0]).form;
  if (form === null) return { found: true, hasForm: false, baseUri: document.baseURI, action: null, submitters: [] };
  const submitters = Array.from(form.querySelectorAll("[formaction]"))
    .map((element) => (typeof element.formAction === "string" ? element.formAction : null))
    .filter((value) => value !== null && value !== "");
  return { found: true, hasForm: true, baseUri: document.baseURI, action: form.action, submitters };
})()`;

interface FormDestinations {
  readonly found: boolean;
  readonly hasForm: boolean;
  readonly baseUri: unknown;
  readonly action: unknown;
  readonly submitters: unknown;
}

const originOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const crossOriginError = (expectedOrigin: string, what: string) =>
  new HostOperationError(
    "PreviewAutomationExecutionError",
    `This login form submits to a different origin than ${expectedOrigin} (${what}), so it was not filled.`,
    { selectorKind: "login-form-action" },
  );

/**
 * A form that posts to a different origin is a credential hand-off the user
 * never approved, and `pageOrigin` cannot see it: origin equality ignores the
 * path, and the page itself is chosen by the (possibly prompt-injected) model.
 * Relative and same-origin actions are the normal case and stay allowed.
 *
 * Runs in the server's own evaluate path. Bots never reach this primitive: a
 * model-provided script is a separate, taint-tracked tool call, and a saved
 * login is refused on any origin where one has run.
 */
async function assertFormDestinations(
  page: BrowserPage,
  expectedOrigin: string,
  fieldSelector = 'input[type="password"]',
): Promise<void> {
  let resolved: FormDestinations;
  try {
    resolved = (await page.evaluate(formDestinationsScript(fieldSelector))) as FormDestinations;
  } catch (cause) {
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `The login form on ${expectedOrigin} could not be checked, so it was not filled.`,
      { selectorKind: "login-form-action", cause: String(cause) },
    );
  }
  if (resolved === null || typeof resolved !== "object" || resolved.found !== true) {
    // Playwright matched a password field, so a page that now reports none has
    // changed under the check. Fail closed rather than fill blind.
    throw new HostOperationError(
      "PreviewAutomationTargetNotEditableError",
      "The login form changed while it was being checked, so it was not filled.",
      { selectorKind: "login-password-field" },
    );
  }
  if (resolved.hasForm) {
    if (originOf(resolved.action) !== expectedOrigin) {
      throw crossOriginError(expectedOrigin, "form action");
    }
    const submitters = Array.isArray(resolved.submitters) ? resolved.submitters : [];
    for (const submitter of submitters) {
      if (originOf(submitter) !== expectedOrigin) {
        throw crossOriginError(expectedOrigin, "a submit button's formaction");
      }
    }
  }
  // A cross-origin <base> retargets every relative URL on the page; it is
  // never normal on a sign-in page, and the form is not the only thing on the
  // page that would follow it.
  if (originOf(resolved.baseUri) !== expectedOrigin) {
    throw crossOriginError(expectedOrigin, "its base URL points elsewhere");
  }
}

/**
 * Types a login without putting either value in an evaluate expression or a
 * model-visible result. The origin is rechecked immediately before each
 * field. Both values are written through element handles resolved on the
 * checked page: a cross-document navigation inside the fill
 * window detaches the handle and aborts instead of retargeting the new page.
 */
export async function performFillLogin(
  page: BrowserPage,
  input: {
    readonly expectedOrigin: string;
    readonly username: string;
    readonly password: string;
  },
  timeoutMs: number,
): Promise<ReadonlyArray<PersonalLoginFilledField>> {
  pageOrigin(page, input.expectedOrigin);
  // Username-first sign-in pages use the same destination and origin guards.
  // Only continue a login form, never guess an OTP or passkey control.
  let usernameFirst = false;
  if ((await page.countLocator(LOGIN_PASSWORD_INPUT)) === 0) {
    for (const candidate of LOGIN_USERNAME_INPUTS) {
      const firstStep = `form:has(${candidate})`;
      const usernameLocator = `${firstStep} ${candidate}`;
      if ((await page.countLocator(usernameLocator)) === 0) continue;
      const fieldSelector = candidate.replace(":visible", "").replace(":not([disabled])", "");
      await assertFormDestinations(page, input.expectedOrigin, fieldSelector);
      const field = await page.resolveElement(usernameLocator, timeoutMs);
      if (field === null) continue;
      try {
        pageOrigin(page, input.expectedOrigin);
        await assertFormDestinations(page, input.expectedOrigin, fieldSelector);
        await field.fill(input.username, PASSWORD_FILL_TIMEOUT_MS);
      } finally {
        await field.dispose().catch(() => undefined);
      }
      usernameFirst = true;
      pageOrigin(page, input.expectedOrigin);
      await assertFormDestinations(page, input.expectedOrigin, fieldSelector);
      const next = `${firstStep} :is(button[type="submit"], input[type="submit"], button:text-matches("^(continue|next)$", "i"))`;
      if ((await page.countLocator(next)) === 0) return ["username"];
      await page.clickLocator(next, timeoutMs);
      try {
        await page.waitForLocator(LOGIN_PASSWORD_INPUT, timeoutMs);
      } catch {
        pageOrigin(page, input.expectedOrigin);
        return ["username"];
      }
      pageOrigin(page, input.expectedOrigin);
      break;
    }
  }
  const focusedForm = `form:has(:focus):has(${LOGIN_PASSWORD_INPUT})`;
  const loginForm = `form:has(${LOGIN_PASSWORD_INPUT})`;
  const formSelector =
    (await page.countLocator(focusedForm)) > 0
      ? focusedForm
      : (await page.countLocator(loginForm)) > 0
        ? loginForm
        : null;
  const scope = formSelector === null ? "" : `${formSelector} `;
  const passwordLocator = `${scope}${LOGIN_PASSWORD_INPUT}`;
  if ((await page.countLocator(passwordLocator)) === 0) {
    throw new HostOperationError(
      "PreviewAutomationTargetNotEditableError",
      "No visible password field was found in the current login form.",
      { selectorKind: "login-password-field" },
    );
  }
  await assertFormDestinations(page, input.expectedOrigin);

  const fields: PersonalLoginFilledField[] = usernameFirst ? ["username"] : [];
  for (const candidate of LOGIN_USERNAME_INPUTS) {
    if (usernameFirst) break;
    const locator = `${scope}${candidate}`;
    if ((await page.countLocator(locator)) === 0) continue;
    const usernameField = await page.resolveElement(locator, timeoutMs);
    if (usernameField === null) {
      throw new HostOperationError(
        "PreviewAutomationTargetNotEditableError",
        "The username field disappeared before the username could be filled.",
        { selectorKind: "login-username-field" },
      );
    }
    try {
      pageOrigin(page, input.expectedOrigin);
      const fieldSelector = candidate.replace(":visible", "").replace(":not([disabled])", "");
      await assertFormDestinations(page, input.expectedOrigin, fieldSelector);
      await usernameField.fill(input.username, PASSWORD_FILL_TIMEOUT_MS);
    } catch (cause) {
      if (cause instanceof HostOperationError) throw cause;
      throw new HostOperationError(
        "PreviewAutomationExecutionError",
        `The username was not filled: the login field on ${input.expectedOrigin} became unavailable before the fill completed.`,
      );
    } finally {
      await usernameField.dispose().catch(() => undefined);
    }
    fields.push("username");
    break;
  }
  // Typing the username is an event the page reacts to: it can swap the form,
  // rewrite the action or reveal a submitter, so the destinations are resolved
  // again rather than trusted from before the keystrokes.
  pageOrigin(page, input.expectedOrigin);
  await assertFormDestinations(page, input.expectedOrigin);

  // Resolve first, check the origin second, fill third. Anything that moves the
  // page between the check and the fill invalidates the handle.
  const passwordField = await page.resolveElement(passwordLocator, timeoutMs);
  if (passwordField === null) {
    throw new HostOperationError(
      "PreviewAutomationTargetNotEditableError",
      "The password field disappeared before the password could be filled.",
      { selectorKind: "login-password-field" },
    );
  }
  try {
    pageOrigin(page, input.expectedOrigin);
    // Last look before the value exists in the page at all.
    await assertFormDestinations(page, input.expectedOrigin);
    await passwordField.fill(input.password, PASSWORD_FILL_TIMEOUT_MS);
  } catch (cause) {
    if (cause instanceof HostOperationError) throw cause;
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `The password was not filled: the login field on ${input.expectedOrigin} became unavailable before the fill completed.`,
    );
  } finally {
    await passwordField.dispose().catch(() => undefined);
  }
  // The page may have navigated as a result of the fill itself; what matters is
  // that the value went to the approved origin, which the pre-fill check proved.
  fields.push("password");
  return fields;
}

export async function captureSnapshot(
  page: BrowserPage,
  actionTimeline: ReadonlyArray<PreviewAutomationActionEvent>,
): Promise<PreviewAutomationSnapshot> {
  const summary = (await page.evaluate(SNAPSHOT_SCRIPT)) as Pick<
    PreviewAutomationSnapshot,
    "url" | "title" | "loading" | "visibleText" | "interactiveElements"
  >;
  const [accessibilityTree, png, viewport] = await Promise.all([
    page.accessibilityTree(),
    page.screenshotPng(),
    page.viewportSize(),
  ]);
  return {
    ...summary,
    accessibilityTree,
    consoleEntries: [...page.consoleEntries()],
    networkEntries: [...page.networkEntries()],
    actionTimeline: [...actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
    },
  };
}

/** A pointer action's coordinates must land inside the page, or Chrome would drop them silently. */
const requireInsideViewport = async (
  page: BrowserPage,
  point: { readonly x: number; readonly y: number },
  what: string,
) => {
  const viewport = await page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `${what} at (${point.x}, ${point.y}) is outside the ${viewport.width}x${viewport.height} viewport.`,
    );
  }
};

const pointerOptions = (input: PreviewAutomationClickInput): PointerClickOptions => ({
  button: input.button,
  clickCount: input.clicks,
  modifiers: input.modifiers,
});

export async function performClick(
  page: BrowserPage,
  input: PreviewAutomationClickInput,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorOf(input);
  if (locator !== null) {
    await page.clickLocator(locator, timeoutMs, pointerOptions(input));
    return;
  }
  const point = { x: input.x ?? 0, y: input.y ?? 0 };
  await requireInsideViewport(page, point, "Click");
  await page.mouseClick(point.x, point.y, pointerOptions(input));
}

/** Moves the pointer onto a target, without pressing anything. */
export async function performHover(
  page: BrowserPage,
  input: PreviewAutomationHoverInput,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorOf(input);
  if (locator !== null) {
    await page.hoverLocator(locator, timeoutMs);
    return;
  }
  const point = { x: input.x ?? 0, y: input.y ?? 0 };
  await requireInsideViewport(page, point, "Hover");
  await page.mouseMove(point.x, point.y);
}

/** Intermediate mouse moves on the way to the drop point, so drag handlers see a drag. */
const DRAG_STEPS = 8;

/**
 * Drags from one element to another, or from one point to another. The button
 * pressed at the start is always let go again, even when the move or the page
 * fails part way, so a drag can never leave the shared browser holding a press.
 */
export async function performDrag(
  page: BrowserPage,
  input: PreviewAutomationDragInput,
  timeoutMs: number,
): Promise<void> {
  if (input.fromLocator !== undefined && input.toLocator !== undefined) {
    await page.dragLocators(input.fromLocator, input.toLocator, timeoutMs);
    return;
  }
  const from = { x: input.fromX ?? 0, y: input.fromY ?? 0 };
  const to = { x: input.toX ?? 0, y: input.toY ?? 0 };
  await requireInsideViewport(page, from, "Drag start");
  await requireInsideViewport(page, to, "Drag end");
  await page.mouseMove(from.x, from.y);
  await page.mouseDown();
  let failure: { readonly cause: unknown } | null = null;
  try {
    await page.mouseMove(to.x, to.y, DRAG_STEPS);
    // A second move onto the exact drop point makes the target see dragover before the drop.
    await page.mouseMove(to.x, to.y);
  } catch (cause) {
    failure = { cause };
  }
  try {
    await page.mouseUp();
  } catch (cause) {
    failure ??= { cause };
  }
  if (failure !== null) throw failure.cause;
}

/** Back, forward or reload; the guard has already looked at where the page is going. */
export async function performHistory(
  page: BrowserPage,
  input: PreviewAutomationHistoryInput,
  timeoutMs: number,
): Promise<void> {
  if (input.action !== "reload") {
    const history = await page.history();
    const possible = input.action === "back" ? history.canGoBack : history.canGoForward;
    if (!possible) {
      throw new HostOperationError(
        "PreviewAutomationExecutionError",
        input.action === "back"
          ? "This tab has no earlier page to go back to."
          : "This tab has no later page to go forward to.",
      );
    }
  }
  if (input.action === "back") await page.goBack();
  else if (input.action === "forward") await page.goForward();
  else await page.reload();
  const readiness = input.readiness ?? "load";
  if (readiness === "none") return;
  await page.waitForLoadState?.(readiness === "load" ? "load" : "domcontentloaded", timeoutMs);
}

export function performType(
  page: BrowserPage,
  input: PreviewAutomationTypeInput,
  timeoutMs: number,
): Promise<void> {
  return page.typeText({
    locator: locatorOf(input),
    text: input.text,
    clear: input.clear ?? false,
    timeoutMs,
  });
}

export function performPress(page: BrowserPage, input: PreviewAutomationPressInput): Promise<void> {
  return page.keyPress([...(input.modifiers ?? []), input.key].join("+"));
}

export async function performScroll(
  page: BrowserPage,
  input: PreviewAutomationScrollInput,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorOf(input);
  const deltaX = input.deltaX ?? 0;
  const deltaY = input.deltaY ?? 0;
  if (locator !== null) {
    await page.scrollLocator(locator, deltaX, deltaY, timeoutMs);
    return;
  }
  await page.mouseWheel(deltaX, deltaY);
}

export function performEvaluate(
  page: BrowserPage,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
): Promise<unknown> {
  // Playwright's `page.evaluate` takes no timeout and resolves the page's
  // own promise, so a never-settling expression would wedge the shared
  // browser's op lock forever. Race it against a rejecting timer that throws
  // the same error shape the other ops use for timeouts.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new HostOperationError(
          "PreviewAutomationTimeoutError",
          `Evaluate timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([page.evaluate(input.expression), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** All provided conditions must hold; they wait concurrently inside one timeout. */
export async function performWaitFor(
  page: BrowserPage,
  input: PreviewAutomationWaitForInput,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorOf(input);
  await Promise.all([
    locator === null ? undefined : page.waitForLocator(locator, timeoutMs),
    input.text === undefined ? undefined : page.waitForText(input.text, timeoutMs),
    input.urlIncludes === undefined
      ? undefined
      : page.waitForUrlIncludes(input.urlIncludes, timeoutMs),
  ]);
}
