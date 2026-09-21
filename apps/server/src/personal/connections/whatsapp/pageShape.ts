import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

/**
 * The only place that knows what WhatsApp Web's DOM looks like.
 *
 * Everything below is a guess about someone else's private markup, and it will
 * break: WhatsApp ships UI changes and owes us nothing. So the rule is that a
 * page which is not the shape we expect produces a refusal, never a different
 * click. Each read runs one expression in the page, returns a plain object,
 * and is decoded here against a strict schema; a missing or wrong-typed field
 * fails, and the caller says "WhatsApp's page has changed" rather than
 * guessing which element was meant.
 *
 * The selectors are not verified against a live page in this build. Live
 * verification has to check each one, and this table is the list to check.
 */
export const PAGE_SELECTORS = {
  /** The left-hand conversation list; absent on the QR screen and mid-load. */
  chatListPane: "#pane-side",
  chatListRow: '#pane-side [role="listitem"]',
  /** WhatsApp puts the full, untruncated chat title in a `title` attribute. */
  chatRowTitle: "span[title]",
  chatRowUnreadBadge: '[aria-label*="unread" i]',
  /** The QR screen. Either of these means there is no logged-in session. */
  qrCanvas: 'canvas[aria-label*="scan" i]',
  qrContainer: '[data-testid="qrcode"]',
  /** Open conversation: its header names who we are talking to. */
  conversationHeaderTitle: "header span[title]",
  conversationMessageRow: '[data-testid="msg-container"], div.message-in, div.message-out',
  messageText: "span.selectable-text",
  /** The composer, and the button that sends what is in it. */
  composer: '[contenteditable="true"][data-tab]',
  /** A delivery tick. Its absence is why a send is reported unconfirmed. */
  outgoingStatusIcon: '[data-icon^="msg-"]',
  /** Settings > Profile, where the owner's own name and number are readable. */
  profileName: '[data-testid="profile-name"], header [title]',
} as const;

export type WhatsAppPageSelectors = typeof PAGE_SELECTORS;

/**
 * Every page read returns this envelope.
 *
 * `shape` is the page's own verdict about itself, decided in the page from the
 * selectors above. It is what turns "WhatsApp changed" into a refusal instead
 * of an empty list that reads like "you have no chats".
 */
const PageShape = Schema.Literals(["ready", "logged_out", "unrecognised"]);
export type WhatsAppPageShapeKind = typeof PageShape.Type;

const ChatRow = Schema.Struct({
  chatId: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  phoneNumber: Schema.NullOr(Schema.String),
  isGroup: Schema.Boolean,
  unread: Schema.Boolean,
  lastMessagePreview: Schema.NullOr(Schema.String),
});

const ChatListRead = Schema.Struct({
  shape: PageShape,
  chats: Schema.Array(ChatRow),
});
export type ChatListRead = typeof ChatListRead.Type;

const OwnProfileRead = Schema.Struct({
  shape: PageShape,
  displayName: Schema.NullOr(Schema.String),
  phoneNumber: Schema.NullOr(Schema.String),
});
export type OwnProfileRead = typeof OwnProfileRead.Type;

const ConversationMessage = Schema.Struct({
  author: Schema.String,
  fromOwner: Schema.Boolean,
  sentAtIso: Schema.String,
  text: Schema.String,
});

const ConversationRead = Schema.Struct({
  shape: PageShape,
  /** Who the open conversation is with, as the page's own header says. */
  headerTitle: Schema.NullOr(Schema.String),
  messages: Schema.Array(ConversationMessage),
});
export type ConversationRead = typeof ConversationRead.Type;

const SendConfirmationRead = Schema.Struct({
  shape: PageShape,
  headerTitle: Schema.NullOr(Schema.String),
  /** The text of the last message the owner sent in this conversation. */
  lastOutgoingText: Schema.NullOr(Schema.String),
  /** False when the bubble still shows no delivery state at all. */
  lastOutgoingHasStatus: Schema.Boolean,
  composerEmpty: Schema.Boolean,
});
export type SendConfirmationRead = typeof SendConfirmationRead.Type;

export class WhatsAppPageShapeError extends Schema.TaggedError<WhatsAppPageShapeError>()(
  "WhatsAppPageShapeError",
  { detail: Schema.String },
) {}

export const PAGE_CHANGED_MESSAGE =
  "WhatsApp's page has changed and hbots no longer recognises it, so it stopped instead of clicking something else. Nothing was read and nothing was sent. Tell the owner the WhatsApp connection needs updating.";

export const LOGGED_OUT_MESSAGE =
  "WhatsApp Web is showing the sign-in QR code, so the owner's session has expired. Nothing was read and nothing was sent. Ask the owner to reconnect WhatsApp in Settings; you cannot scan the code yourself.";

const decodeWith = <A, I>(schema: Schema.Codec<A, I>, label: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (raw: unknown): Effect.Effect<A, WhatsAppPageShapeError> =>
    decode(raw).pipe(
      Effect.mapError(
        () =>
          new WhatsAppPageShapeError({
            detail: `The ${label} read did not come back in the shape this build understands.`,
          }),
      ),
      Effect.flatMap((value) => {
        const shape = (value as { readonly shape: WhatsAppPageShapeKind }).shape;
        if (shape === "ready") return Effect.succeed(value);
        return Effect.fail(
          new WhatsAppPageShapeError({
            detail: shape === "logged_out" ? LOGGED_OUT_MESSAGE : PAGE_CHANGED_MESSAGE,
          }),
        );
      }),
    );
};

export const decodeChatList = decodeWith(ChatListRead, "chat list");
export const decodeOwnProfile = decodeWith(OwnProfileRead, "profile");
export const decodeConversation = decodeWith(ConversationRead, "conversation");
export const decodeSendConfirmation = decodeWith(SendConfirmationRead, "send confirmation");

/**
 * The shared preamble every expression starts with.
 *
 * It answers one question before anything else reads the DOM: is this a
 * logged-in WhatsApp at all. Reporting `logged_out` and `unrecognised`
 * separately matters, because one is the owner reconnecting and the other is
 * this build needing a fix, and collapsing them would send the owner to scan a
 * QR code that would not help.
 */
const PREAMBLE = (selectors: WhatsAppPageSelectors) => `
  const S = ${JSON.stringify(selectors)};
  const q = (sel, root) => (root || document).querySelector(sel);
  const all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const loggedOut = q(S.qrCanvas) !== null || q(S.qrContainer) !== null;
  const pane = q(S.chatListPane);
  const shape = loggedOut ? "logged_out" : pane === null ? "unrecognised" : "ready";
  const text = (node) => (node === null ? null : (node.textContent || "").trim() || null);
`;

/**
 * WhatsApp's own ids are `<number>@c.us` for a person and `<id>@g.us` for a
 * group, and it puts them on the row. Reading the group flag off the id rather
 * than off an icon means a restyled icon cannot turn a group into a person.
 */
const CHAT_ROW_READER = `
  const rowsOf = () => all(S.chatListRow, pane).map((row) => {
    const titleNode = q(S.chatRowTitle, row);
    const displayName = titleNode === null ? null : (titleNode.getAttribute("title") || titleNode.textContent || "").trim();
    const idAttr = row.getAttribute("data-id") || (q("[data-id]", row) || {}).getAttribute?.("data-id") || null;
    const chatId = typeof idAttr === "string" && idAttr.length > 0 ? idAttr : displayName === null ? null : "name:" + displayName;
    if (displayName === null || displayName.length === 0 || chatId === null) return null;
    const isGroup = chatId.indexOf("@g.us") !== -1;
    const digits = chatId.indexOf("@c.us") === -1 ? null : chatId.split("@")[0].replace(/[^0-9]/g, "");
    return {
      chatId,
      displayName,
      phoneNumber: digits === null || digits.length < 6 ? null : "+" + digits,
      isGroup,
      unread: q(S.chatRowUnreadBadge, row) !== null,
      lastMessagePreview: null,
    };
  }).filter((row) => row !== null);
`;

const expression = (body: string) => `(() => { ${PREAMBLE(PAGE_SELECTORS)} ${body} })()`;

export const chatListExpression = (limit: number) =>
  expression(`
    ${CHAT_ROW_READER}
    return { shape, chats: shape === "ready" ? rowsOf().slice(0, ${Math.max(1, Math.floor(limit))}) : [] };
  `);

export const ownProfileExpression = () =>
  expression(`
    const header = q(S.profileName);
    const name = text(header);
    const numberNode = Array.from(document.querySelectorAll("span,div"))
      .map((node) => (node.textContent || "").trim())
      .find((value) => /^\\+[0-9][0-9 ()-]{6,}$/.test(value)) || null;
    return { shape, displayName: name, phoneNumber: numberNode };
  `);

export const conversationExpression = (limit: number) =>
  expression(`
    const header = text(q(S.conversationHeaderTitle));
    const rows = all(S.conversationMessageRow).slice(-${Math.max(1, Math.floor(limit))});
    const messages = rows.map((row) => {
      const outgoing = row.className.indexOf("message-out") !== -1;
      const body = q(S.messageText, row);
      return {
        author: outgoing ? "the owner" : header || "unknown",
        fromOwner: outgoing,
        sentAtIso: row.getAttribute("data-pre-plain-text") || "",
        text: body === null ? "" : (body.textContent || ""),
      };
    });
    return { shape, headerTitle: header, messages: shape === "ready" ? messages : [] };
  `);

export const sendConfirmationExpression = () =>
  expression(`
    const header = text(q(S.conversationHeaderTitle));
    const outgoing = all(S.conversationMessageRow).filter((row) => row.className.indexOf("message-out") !== -1);
    const last = outgoing.length === 0 ? null : outgoing[outgoing.length - 1];
    const body = last === null ? null : q(S.messageText, last);
    const composer = q(S.composer);
    return {
      shape,
      headerTitle: header,
      lastOutgoingText: body === null ? null : (body.textContent || ""),
      lastOutgoingHasStatus: last !== null && q(S.outgoingStatusIcon, last) !== null,
      composerEmpty: composer === null ? false : (composer.textContent || "").trim().length === 0,
    };
  `);
