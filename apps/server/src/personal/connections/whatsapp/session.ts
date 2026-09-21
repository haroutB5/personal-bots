import * as NodeCrypto from "node:crypto";

import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { PersonalBrowser } from "../../browser/PersonalBrowser.ts";
import { PAGE_SELECTORS } from "./pageShape.ts";

/**
 * Driving WhatsApp Web inside the browser this app already owns.
 *
 * There is no WhatsApp library here and there will not be one. A protocol
 * client would reimplement WhatsApp's own wire format, which is both a much
 * louder signal to WhatsApp and a much larger supply-chain surface, and a
 * library with its own browser would sit outside the profile, the egress guard
 * and the takeover path this app already protects. Reusing the shared browser
 * keeps one session, one profile and one place the owner can see what happened.
 *
 * The verbs below are the whole surface the adapter gets, which is what makes
 * the adapter testable against fixtures rather than against WhatsApp.
 */

export const WHATSAPP_URL = "https://web.whatsapp.com/";

/**
 * WhatsApp's tab belongs to this reserved thread, not to whichever bot asked.
 *
 * One tab means one page whose shape is checked in one place, and an owner
 * signing in on the connect screen and a bot reading a chat an hour later are
 * looking at the same session. The caller's own thread is still what the
 * gateway's egress guard is evaluated against, before any of this runs.
 */
export const WHATSAPP_THREAD_ID = ThreadId.make("personal-connection-whatsapp");

/** Any control session id works to hand the browser back; the lease ignores it. */
const HANDBACK_SESSION_ID = "personal-connection-whatsapp";

export class WhatsAppSessionError extends Schema.TaggedError<WhatsAppSessionError>()(
  "WhatsAppSessionError",
  { detail: Schema.String },
) {}

export class WhatsAppSession extends Context.Service<
  WhatsAppSession,
  {
    /** Opens WhatsApp Web and hands the owner control so they can scan the QR. */
    readonly openForSignIn: (viewerSessionId: string) => Effect.Effect<void, WhatsAppSessionError>;
    /** Takes control back after the owner has signed in. */
    readonly handBack: () => Effect.Effect<void, WhatsAppSessionError>;
    /** Makes sure the tab is on WhatsApp before anything is read from it. */
    readonly ensureOpen: () => Effect.Effect<void, WhatsAppSessionError>;
    readonly read: (expression: string) => Effect.Effect<unknown, WhatsAppSessionError>;
    readonly openChat: (chatId: string) => Effect.Effect<void, WhatsAppSessionError>;
    readonly typeMessage: (text: string) => Effect.Effect<void, WhatsAppSessionError>;
    /** Presses Enter in the composer. Never called twice for one message. */
    readonly submit: () => Effect.Effect<void, WhatsAppSessionError>;
  }
>()("t3/personal/connections/whatsapp/session/WhatsAppSession") {}

/** A chat id goes into a CSS attribute selector, so it is quoted, not trusted. */
export const chatRowSelector = (chatId: string) =>
  `#pane-side [data-id="${chatId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;

export const make = Effect.gen(function* () {
  const browser = yield* PersonalBrowser;

  const automate = (input: {
    readonly operation: "navigate" | "evaluate" | "click" | "type" | "press" | "waitFor";
    readonly payload: Readonly<Record<string, unknown>>;
    readonly timeoutMs: number;
  }) =>
    browser
      .handleAutomationRequest({
        requestId: NodeCrypto.randomUUID(),
        threadId: WHATSAPP_THREAD_ID,
        operation: input.operation,
        input: input.payload,
        timeoutMs: input.timeoutMs,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new WhatsAppSessionError({
              detail: `The shared browser could not ${input.operation} on WhatsApp: ${error.message}`,
            }),
        ),
      );

  const ensureOpen = () =>
    automate({
      operation: "navigate",
      payload: { url: WHATSAPP_URL, readiness: "load" },
      timeoutMs: 45_000,
    }).pipe(
      Effect.andThen(
        // The chat pane is what "signed in and loaded" looks like. Waiting for
        // it here rather than reading straight away is the difference between
        // "the page has changed" and "the page had not finished loading".
        automate({
          operation: "waitFor",
          payload: { selector: PAGE_SELECTORS.chatListPane, timeoutMs: 20_000 },
          timeoutMs: 25_000,
        }).pipe(Effect.ignore),
      ),
      Effect.asVoid,
    );

  return WhatsAppSession.of({
    openForSignIn: (viewerSessionId) =>
      ensureOpen().pipe(
        // Control goes to the owner whatever the page did: a QR screen and a
        // page that failed to load both need a human looking at it.
        Effect.ignore,
        Effect.andThen(browser.takeControl(viewerSessionId)),
        Effect.asVoid,
      ),
    handBack: () => browser.returnToAgent(HANDBACK_SESSION_ID).pipe(Effect.asVoid),
    ensureOpen,
    read: (expression) =>
      automate({
        operation: "evaluate",
        payload: { expression, awaitPromise: false, returnByValue: true },
        timeoutMs: 15_000,
      }),
    openChat: (chatId) =>
      automate({
        operation: "click",
        payload: { selector: chatRowSelector(chatId), timeoutMs: 10_000 },
        timeoutMs: 15_000,
      }).pipe(Effect.asVoid),
    typeMessage: (text) =>
      automate({
        operation: "type",
        payload: { selector: PAGE_SELECTORS.composer, text, clear: true, timeoutMs: 15_000 },
        timeoutMs: 20_000,
      }).pipe(Effect.asVoid),
    submit: () =>
      automate({ operation: "press", payload: { key: "Enter" }, timeoutMs: 10_000 }).pipe(
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(WhatsAppSession, make);
