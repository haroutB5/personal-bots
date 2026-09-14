/**
 * Preview-automation operations over a {@link BrowserPage}. Logic mirrors the
 * desktop host (`apps/desktop/src/preview/Manager.ts` snapshot/click/type) but
 * uses Playwright locators directly instead of injected selector engines.
 */
// @effect-diagnostics globalTimers:off -- performEvaluate races a non-Effect Playwright promise against a plain timer and clears it in `finally` on every path.
import type {
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";

import type { BrowserPage } from "./driver.ts";

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

/** Maps Playwright failures onto the error tags the broker classifies. */
export function classifyPageError(cause: unknown, input: SelectorInput = {}): HostOperationError {
  if (cause instanceof HostOperationError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || /Timeout \d+ms exceeded/.test(message)) {
    return new HostOperationError("PreviewAutomationTimeoutError", firstLine(message));
  }
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
  if (/has been closed|Target closed|Target page/i.test(message)) {
    return new HostOperationError("PreviewAutomationTabNotFoundError", firstLine(message));
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
const FORM_DESTINATIONS_SCRIPT = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const fields = Array.from(document.querySelectorAll('input[type="password"]'))
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
async function assertFormDestinations(page: BrowserPage, expectedOrigin: string): Promise<void> {
  let resolved: FormDestinations;
  try {
    resolved = (await page.evaluate(FORM_DESTINATIONS_SCRIPT)) as FormDestinations;
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
 * field, so a username-triggered navigation cannot carry the password onto a
 * different origin, and the password is written through an element handle
 * resolved on the checked page: a cross-document navigation inside the fill
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

  const fields: PersonalLoginFilledField[] = [];
  for (const candidate of LOGIN_USERNAME_INPUTS) {
    const locator = `${scope}${candidate}`;
    if ((await page.countLocator(locator)) === 0) continue;
    pageOrigin(page, input.expectedOrigin);
    await page.typeText({ locator, text: input.username, clear: true, timeoutMs });
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

export async function performClick(
  page: BrowserPage,
  input: PreviewAutomationClickInput,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorOf(input);
  if (locator !== null) {
    await page.clickLocator(locator, timeoutMs);
    return;
  }
  const x = input.x ?? 0;
  const y = input.y ?? 0;
  const viewport = await page.viewportSize();
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new HostOperationError(
      "PreviewAutomationExecutionError",
      `Click at (${x}, ${y}) is outside the ${viewport.width}x${viewport.height} viewport.`,
    );
  }
  await page.mouseClick(x, y);
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
