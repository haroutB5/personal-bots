import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import type { ProjectFileFailure, ProjectReadFileResult } from "@t3tools/contracts";

/**
 * What the file sheet shows. One tag per screen state, so the renderer has no
 * combination of loading, error and content flags to reconcile.
 */
export type FilePreviewState =
  | { readonly _tag: "NoFolder" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Image"; readonly url: string }
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Error"; readonly reason: FilePreviewErrorReason };

export type FilePreviewErrorReason = "not-found" | "open-failed" | "read-failed" | "timed-out";

/**
 * How the sheet reads the file it was asked to show. Text goes through the
 * project file RPC, images through a signed asset URL, and everything else has
 * no phone preview. The route comes from the path before any request starts,
 * so a text file never waits on an asset URL the server refuses to mint.
 */
export type FilePreviewRoute = "text" | "image" | "unsupported";

/** The project file read, reduced to what the sheet shows. */
export type FileTextRead =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Loaded"; readonly text: string; readonly truncated: boolean }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Binary" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "TimedOut" };

/** A settled project read, or the server's kind for the failure. */
export type FileReadOutcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Loaded"; readonly result: ProjectReadFileResult }
  | { readonly _tag: "Failed"; readonly failure: ProjectFileFailure | null };

/** The one source a preview draws from, chosen from the path's route. */
export type FilePreviewSource =
  | { readonly _tag: "Text"; readonly read: FileTextRead }
  | { readonly _tag: "Image"; readonly asset: AssetUrlState }
  | { readonly _tag: "Unsupported" };

export interface FilePreviewInput {
  readonly folder: string | null;
  readonly path: string | null;
  readonly source: FilePreviewSource;
}

const TEXT_EXTENSIONS =
  /\.(?:txt|md|markdown|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yml|yaml|toml|ini|cfg|log|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|env)$/i;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

export function filePreviewRoute(path: string): FilePreviewRoute {
  if (TEXT_EXTENSIONS.test(path)) return "text";
  if (IMAGE_EXTENSIONS.test(path)) return "image";
  return "unsupported";
}

export function fileTextRead(outcome: FileReadOutcome): FileTextRead {
  switch (outcome._tag) {
    case "Pending":
      return { _tag: "Pending" };
    case "Failed":
      switch (outcome.failure) {
        case "protected_file":
          return { _tag: "Denied" };
        case "binary_file":
          return { _tag: "Binary" };
        default:
          return { _tag: "Failed" };
      }
    case "Loaded":
      return outcome.result.exists === false
        ? { _tag: "NotFound" }
        : {
            _tag: "Loaded",
            text: outcome.result.contents,
            truncated: outcome.result.truncated,
          };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function filePreviewState(input: FilePreviewInput): FilePreviewState {
  // The sheet is closed until a file is picked.
  if (input.path === null) return { _tag: "Loading" };
  if (input.folder === null) return { _tag: "NoFolder" };
  switch (input.source._tag) {
    case "Unsupported":
      return { _tag: "Unsupported" };
    case "Image": {
      const asset = input.source.asset;
      if (asset._tag === "Loading") return { _tag: "Loading" };
      if (asset._tag === "Failure") {
        if (asset.protectedFile === true) return { _tag: "Denied" };
        if (asset.notFound === true) return { _tag: "Error", reason: "not-found" };
        return { _tag: "Error", reason: "open-failed" };
      }
      return { _tag: "Image", url: asset.url };
    }
    case "Text":
      switch (input.source.read._tag) {
        case "Pending":
          return { _tag: "Loading" };
        case "Loaded":
          return { _tag: "Text", text: input.source.read.text };
        case "Denied":
          return { _tag: "Denied" };
        case "NotFound":
          return { _tag: "Error", reason: "not-found" };
        case "Binary":
          return { _tag: "Unsupported" };
        case "Failed":
          return { _tag: "Error", reason: "read-failed" };
        case "TimedOut":
          return { _tag: "Error", reason: "timed-out" };
        default: {
          const unreachable: never = input.source.read;
          return unreachable;
        }
      }
  }
}

export function filePreviewErrorText(reason: FilePreviewErrorReason): string {
  switch (reason) {
    case "not-found":
      return "That file isn't there any more.";
    case "open-failed":
      return "Couldn't open that file.";
    case "read-failed":
      return "Couldn't read that file.";
    case "timed-out":
      return "That file took too long to read.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
