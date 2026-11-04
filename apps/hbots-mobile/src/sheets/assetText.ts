export interface TextResponse {
  readonly ok: boolean;
  readonly text: () => Promise<string>;
}

export type TextFetcher = (url: string, init?: RequestInit) => Promise<TextResponse>;

export class AssetReadRefusedError extends Error {
  constructor() {
    super("Couldn't read that file.");
    this.name = "AssetReadRefusedError";
  }
}

/**
 * The asset URL is already signed and unique per open, so it needs no cache
 * directive. `no-store` makes the fetch polyfill append a `_=` timestamp to the
 * URL, which is the request that failed for text files while images, loaded by
 * the native image component, kept working.
 */
export async function readAssetText(url: string, doFetch: TextFetcher = fetch): Promise<string> {
  const response = await doFetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!response.ok) throw new AssetReadRefusedError();
  return response.text();
}
