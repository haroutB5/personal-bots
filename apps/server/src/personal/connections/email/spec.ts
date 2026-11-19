import * as Schema from "effect/Schema";

const NO_ADDRESS_BREAKERS = String.raw`[^\s@,;<>"()\[\]\\]`;
const ADDRESS_PATTERN = new RegExp(
  `^${NO_ADDRESS_BREAKERS}+@${NO_ADDRESS_BREAKERS}+\\.${NO_ADDRESS_BREAKERS}+$`,
);

/** One plain address: no display name, list separator or bracket that could smuggle a second recipient. */
export const EmailAddress = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(ADDRESS_PATTERN),
);

/** A connected mailbox, as `list_connections` shows it. */
export const Mailbox = EmailAddress;

/** A provider message, thread or draft id. Interpolated into URL paths, so no slash or space. */
export const MailRef = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_\-=+.]{1,512}$/));

const SearchText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n]+$/),
);
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/),
);
const Count = (max: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(max));

export const MAIL_QUERY_FIELDS = {
  mailbox: Mailbox,
  from: Schema.optionalKey(SearchText),
  to: Schema.optionalKey(SearchText),
  subject: Schema.optionalKey(SearchText),
  text: Schema.optionalKey(SearchText),
  afterIso: Schema.optionalKey(IsoDate),
  beforeIso: Schema.optionalKey(IsoDate),
  unreadOnly: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Count(50)),
} as const;

export const LIST_THREADS_FIELDS = {
  mailbox: Mailbox,
  unreadOnly: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Count(50)),
} as const;

export const READ_MESSAGE_FIELDS = { mailbox: Mailbox, messageRef: MailRef } as const;

export const READ_THREAD_FIELDS = {
  mailbox: Mailbox,
  threadRef: MailRef,
  limit: Schema.optionalKey(Count(20)),
} as const;

export const DRAFT_FIELDS = {
  mailbox: Mailbox,
  to: Schema.Array(EmailAddress).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  cc: Schema.optionalKey(Schema.Array(EmailAddress).check(Schema.isMaxLength(20))),
  subject: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(300),
    Schema.isPattern(/^[^\r\n]+$/),
  ),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  replyTo: Schema.optionalKey(MailRef),
} as const;

export const MAX_BODY_CHARS = 20_000;

export interface DraftSummaryInput {
  readonly mailbox: string;
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string;
}

const recipients = (input: DraftSummaryInput) =>
  `to ${input.to.join(", ")}${
    input.cc !== undefined && input.cc.length > 0 ? ` (cc ${input.cc.join(", ")})` : ""
  }`;

export const draftSummary = (input: DraftSummaryInput) =>
  `Save a draft in ${input.mailbox} ${recipients(input)}, subject "${input.subject}". Nothing is sent.`;

export const emailTargetResource = (vendorId: string, mailbox: string) =>
  `email:${vendorId}:${mailbox.toLowerCase()}`;
