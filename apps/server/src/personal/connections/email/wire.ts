import { EmailAddress } from "./spec.ts";
import * as Schema from "effect/Schema";

import type { MailParty } from "./mailApi.ts";

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

export const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const isAddress = Schema.is(EmailAddress);

export const validAddress = (value: string): string => {
  const trimmed = value.trim();
  return isAddress(trimmed) ? trimmed.toLowerCase() : "";
};

/** Splits on commas that are not inside a quoted name or an angle bracket. */
const splitHeaderList = (header: string): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle += 1;
    else if (!quoted && char === ">") angle = Math.max(0, angle - 1);
    if (char === "," && !quoted && angle === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

/** One `Name <addr>` or bare address. A part with no usable address keeps its text as the name. */
export const parseParty = (raw: string): MailParty => {
  const text = raw.trim();
  const bracket = /^(.*)<([^<>]*)>\s*$/.exec(text);
  if (bracket !== null) {
    return {
      address: validAddress(bracket[2] ?? ""),
      name: (bracket[1] ?? "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    };
  }
  const address = validAddress(text);
  return address === "" ? { address: "", name: text } : { address, name: "" };
};

export const parsePartyList = (header: string): ReadonlyArray<MailParty> =>
  splitHeaderList(header).map(parseParty);

/** Tags and entities out of an HTML-only body, so a bot reads words rather than markup. */
export const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const capBody = (text: string, max: number) =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
