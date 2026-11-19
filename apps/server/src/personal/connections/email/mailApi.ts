import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import type { ConnectionVendorError } from "../adapters.ts";

/**
 * What one provider must be able to do with a mailbox, in the words of mail
 * rather than of either provider's API. The adapter holds one of these per
 * vendor and nothing above it branches on which. Bodies and subjects here are
 * raw third-party text: quoting is the adapter's job, not the provider's.
 */

export interface MailParty {
  /** Empty when the header carried no usable address. */
  readonly address: string;
  readonly name: string;
}

export interface MailSummary {
  readonly ref: string;
  readonly threadRef: string;
  readonly from: MailParty | null;
  readonly to: ReadonlyArray<MailParty>;
  readonly subject: string;
  readonly receivedAtIso: string;
  readonly unread: boolean;
  readonly snippet: string;
}

export interface MailAttachment {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface MailMessage extends MailSummary {
  readonly cc: ReadonlyArray<MailParty>;
  readonly bodyText: string;
  readonly bodyTruncated: boolean;
  readonly attachments: ReadonlyArray<MailAttachment>;
}

export interface ThreadSummary {
  readonly threadRef: string;
  readonly latest: MailSummary;
  readonly unread: boolean;
}

export interface MailQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly text?: string | undefined;
  readonly afterIso?: string | undefined;
  readonly beforeIso?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
  readonly limit: number;
}

export interface MailDraft {
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  /** The message this answers. Keeps the conversation together at the provider. */
  readonly replyTo: string | null;
}

/** An access token and the operation it is for, so every failure names what was being done. */
export interface MailCall {
  readonly operationId: string;
  readonly token: Redacted.Redacted<string>;
}

type Failing<A> = Effect.Effect<A, ConnectionVendorError>;

export interface MailApi {
  /** The request and reply shape this implementation speaks, compared with the reviewed one by the gateway. */
  readonly vendorSchema: string;
  readonly search: (call: MailCall, query: MailQuery) => Failing<ReadonlyArray<MailSummary>>;
  readonly listThreads: (
    call: MailCall,
    query: { readonly limit: number; readonly unreadOnly: boolean },
  ) => Failing<ReadonlyArray<ThreadSummary>>;
  readonly readMessage: (call: MailCall, ref: string) => Failing<MailMessage>;
  /** Oldest first. */
  readonly readThread: (
    call: MailCall,
    ref: string,
    limit: number,
  ) => Failing<ReadonlyArray<MailMessage>>;
  /** With `update`, replaces that draft's content in place instead of adding a second one. */
  readonly createDraft: (
    call: MailCall,
    draft: MailDraft,
    update: string | null,
  ) => Failing<{ readonly draftRef: string }>;
  readonly send: (call: MailCall, draft: MailDraft) => Failing<void>;
}

export const MAX_BODY_CHARS_RETURNED = 20_000;
