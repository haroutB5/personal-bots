import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";

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

/** The text read runs after the asset URL is minted. */
export type FileTextRead =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Loaded"; readonly text: string }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "TimedOut" };

export interface FilePreviewInput {
  readonly folder: string | null;
  readonly path: string | null;
  readonly asset: AssetUrlState;
  readonly text: FileTextRead;
}

const TEXT_EXTENSIONS =
  /\.(?:txt|md|markdown|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yml|yaml|toml|ini|cfg|log|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|env)$/i;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

function previewKind(path: string): "text" | "image" | "unsupported" {
  if (TEXT_EXTENSIONS.test(path)) return "text";
  if (IMAGE_EXTENSIONS.test(path)) return "image";
  return "unsupported";
}

export function isTextFilePath(path: string): boolean {
  return TEXT_EXTENSIONS.test(path);
}

export function filePreviewState(input: FilePreviewInput): FilePreviewState {
  // The sheet is closed until a file is picked.
  if (input.path === null) return { _tag: "Loading" };
  if (input.folder === null) return { _tag: "NoFolder" };
  if (input.asset._tag === "Loading") return { _tag: "Loading" };
  if (input.asset._tag === "Failure") {
    if (input.asset.protectedFile === true) return { _tag: "Denied" };
    if (input.asset.notFound === true) return { _tag: "Error", reason: "not-found" };
    return { _tag: "Error", reason: "open-failed" };
  }
  const kind = previewKind(input.path);
  if (kind === "unsupported") return { _tag: "Unsupported" };
  if (kind === "image") return { _tag: "Image", url: input.asset.url };
  switch (input.text._tag) {
    case "Pending":
      return { _tag: "Loading" };
    case "Loaded":
      return { _tag: "Text", text: input.text.text };
    case "Failed":
      return { _tag: "Error", reason: "read-failed" };
    case "TimedOut":
      return { _tag: "Error", reason: "timed-out" };
    default: {
      const unreachable: never = input.text;
      return unreachable;
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
