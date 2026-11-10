import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";

/**
 * What the file sheet shows. One tag per screen state, so the renderer has no
 * combination of loading, error and content flags to reconcile.
 */
export type FilePreviewState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Image"; readonly url: string }
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Error"; readonly reason: FilePreviewErrorReason };

export type FilePreviewErrorReason =
  | "not-found"
  | "denied-access"
  | "open-failed"
  | "read-failed"
  | "timed-out";

/**
 * How the sheet reads the file it was asked to show. Both routes mint a
 * per-message asset URL; text downloads it and decodes its bytes, images show
 * it inline. The route comes from the path before any request starts.
 */
export type FilePreviewRoute = "text" | "image" | "unsupported";

/** The text read once the signed URL is minted. */
export type FileTextRead =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Loaded"; readonly text: string; readonly truncated: boolean }
  | { readonly _tag: "Binary" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "TimedOut" };

/** The one source a preview draws from, chosen from the path's route. */
export type FilePreviewSource =
  | { readonly _tag: "Text"; readonly asset: AssetUrlState; readonly read: FileTextRead }
  | { readonly _tag: "Image"; readonly asset: AssetUrlState }
  | { readonly _tag: "Unsupported" };

export interface FilePreviewInput {
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

/** A refused mint carries the reason; every reason gets its own sentence. */
function assetFailureState(asset: AssetUrlState): FilePreviewState | null {
  if (asset._tag === "Loading") return { _tag: "Loading" };
  if (asset._tag === "Success") return null;
  if (asset.protectedFile === true) return { _tag: "Denied" };
  if (asset.notFound === true) return { _tag: "Error", reason: "not-found" };
  if (asset.deniedAccess === true) return { _tag: "Error", reason: "denied-access" };
  return { _tag: "Error", reason: "open-failed" };
}

export function filePreviewState(input: FilePreviewInput): FilePreviewState {
  // The sheet is closed until a file is picked.
  if (input.path === null) return { _tag: "Loading" };
  switch (input.source._tag) {
    case "Unsupported":
      return { _tag: "Unsupported" };
    case "Image": {
      const failure = assetFailureState(input.source.asset);
      if (failure !== null) return failure;
      if (input.source.asset._tag !== "Success") return { _tag: "Loading" };
      return { _tag: "Image", url: input.source.asset.url };
    }
    case "Text": {
      const failure = assetFailureState(input.source.asset);
      if (failure !== null) return failure;
      switch (input.source.read._tag) {
        case "Pending":
          return { _tag: "Loading" };
        case "Loaded":
          return { _tag: "Text", text: input.source.read.text };
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
}

export function filePreviewErrorText(reason: FilePreviewErrorReason): string {
  switch (reason) {
    case "not-found":
      return "That file isn't there any more.";
    case "denied-access":
      return "This connection isn't allowed to open that file.";
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
