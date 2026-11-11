import * as Data from "effect/Data";

/** What the setting asks for. Owned is the default and needs nothing; shared names Brave's own data folder. */
export type BrowserBackendSetting =
  | { readonly kind: "owned" }
  | { readonly kind: "shared"; readonly userDataDir: string };

export type SharedAttachReason = "brave-not-running" | "port-file-stale" | "wrong-browser";

export class SharedAttachError extends Data.TaggedError("SharedAttachError")<{
  readonly reason: SharedAttachReason;
  readonly message: string;
}> {}

export const sharedAttachSentence = (_reason: SharedAttachReason): string => "";
