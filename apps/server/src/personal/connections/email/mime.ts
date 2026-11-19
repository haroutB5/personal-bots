/**
 * A plain-text email as the bytes Gmail's `raw` field wants.
 *
 * Text only: no attachments and no HTML, so there is nothing to boundary. The
 * subject and every address were already refused if they held a line break,
 * and the subject is encoded here regardless so a non-ASCII word cannot be
 * misread. The body goes out as base64 so no line in it can be mistaken for a
 * header.
 */

export interface MimeMessage {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
}

const encodedWord = (text: string) =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;

const folded = (base64: string) => base64.match(/.{1,76}/g)?.join("\r\n") ?? "";

const headerValue = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export const buildRfc822 = (message: MimeMessage): string => {
  const lines = [
    `From: ${headerValue(message.from)}`,
    `To: ${message.to.map(headerValue).join(", ")}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.map(headerValue).join(", ")}`] : []),
    `Subject: ${encodedWord(headerValue(message.subject))}`,
    ...(message.inReplyTo === null ? [] : [`In-Reply-To: ${headerValue(message.inReplyTo)}`]),
    ...(message.references === null ? [] : [`References: ${headerValue(message.references)}`]),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    folded(Buffer.from(message.body, "utf8").toString("base64")),
  ];
  return lines.join("\r\n");
};

export const toBase64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
