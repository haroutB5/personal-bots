export interface TextResponse {
  readonly ok: boolean;
  readonly text: () => Promise<string>;
}

export type TextFetcher = (url: string, init?: RequestInit) => Promise<TextResponse>;

/**
 * The asset URL is already signed and unique per open. A cache directive is not
 * needed, and `no-store` makes the fetch polyfill rewrite the URL with a `_=`
 * query parameter, which the signed asset route does not expect.
 */
export async function readAssetText(url: string, doFetch: TextFetcher = fetch): Promise<string> {
  const response = await doFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Couldn't read that file.");
  return response.text();
}
