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

/**
 * Types a login without putting either value in an evaluate expression or a
 * model-visible result. The origin is rechecked immediately before each
 * field, so a username-triggered navigation cannot carry the password onto a
 * different origin.
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
  const focusedForm = `form:has(:focus):has(${LOGIN_PASSWORD_INPUT})`;
  const loginForm = `form:has(${LOGIN_PASSWORD_INPUT})`;
  const scope =
    (await page.countLocator(focusedForm)) > 0
      ? `${focusedForm} `
      : (await page.countLocator(loginForm)) > 0
        ? `${loginForm} `
        : "";
  const passwordLocator = `${scope}${LOGIN_PASSWORD_INPUT}`;
  if ((await page.countLocator(passwordLocator)) === 0) {
    throw new HostOperationError(
      "PreviewAutomationTargetNotEditableError",
      "No visible password field was found in the current login form.",
      { selectorKind: "login-password-field" },
    );
  }

  const fields: PersonalLoginFilledField[] = [];
  for (const candidate of LOGIN_USERNAME_INPUTS) {
    const locator = `${scope}${candidate}`;
    if ((await page.countLocator(locator)) === 0) continue;
    pageOrigin(page, input.expectedOrigin);
    await page.typeText({ locator, text: input.username, clear: true, timeoutMs });
    fields.push("username");
    break;
  }

  pageOrigin(page, input.expectedOrigin);
  await page.typeText({
    locator: passwordLocator,
    text: input.password,
    clear: true,
    timeoutMs,
  });
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
