/**
 * The one error the catalogue's install and download code fails with. It
 * carries the failure kind the phone turns into a sentence (SPEC section 7)
 * and only fields that are safe to show: no URL beyond its host, no query,
 * no token, no path outside the install folder.
 *
 * @module provider/catalog/errors
 */
import type { ProviderInstallFailure, ProviderInstallFailureKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class CatalogInstallError extends Schema.TaggedError<CatalogInstallError>()(
  "CatalogInstallError",
  {
    kind: Schema.Literals([
      "network",
      "checksum",
      "disk",
      "wontStart",
      "unsupported",
      "npm",
      "other",
    ]),
    /** One plain line. The log keeps the underlying cause. */
    detail: Schema.String,
    neededBytes: Schema.optional(Schema.Number),
    freeBytes: Schema.optional(Schema.Number),
    host: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

export const isCatalogInstallError = Schema.is(CatalogInstallError);

export const installError = (
  kind: ProviderInstallFailureKind,
  detail: string,
  extra: {
    readonly neededBytes?: number;
    readonly freeBytes?: number;
    readonly host?: string;
    readonly cause?: unknown;
  } = {},
) =>
  new CatalogInstallError({
    kind,
    detail,
    ...(extra.neededBytes === undefined ? {} : { neededBytes: extra.neededBytes }),
    ...(extra.freeBytes === undefined ? {} : { freeBytes: extra.freeBytes }),
    ...(extra.host === undefined ? {} : { host: extra.host }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

/** Passes an install error through; wraps anything else as `other` with the fallback sentence. */
export const asInstallError =
  (fallback: string, kind: ProviderInstallFailureKind = "other") =>
  (cause: unknown): CatalogInstallError =>
    isCatalogInstallError(cause) ? cause : installError(kind, fallback, { cause });

const MAX_DETAIL = 160;

/** A URL keeps only its host: userinfo, path, query and fragment can all carry a token or code. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/giu, (raw) => {
    try {
      return new URL(raw).host;
    } catch {
      return "[link]";
    }
  });
}

/** First non-empty line, URLs redacted, at most 160 characters: what the card may show. */
export function firstSafeLine(text: string): string {
  const line =
    redactUrls(text)
      .split(/\r?\n/u)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "";
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

/** The wire shape of a failure. */
export function toInstallFailure(error: CatalogInstallError): ProviderInstallFailure {
  return {
    kind: error.kind,
    detail: firstSafeLine(error.detail),
    ...(error.neededBytes === undefined ? {} : { neededBytes: error.neededBytes }),
    ...(error.freeBytes === undefined ? {} : { freeBytes: error.freeBytes }),
    ...(error.host === undefined ? {} : { host: error.host }),
  };
}
