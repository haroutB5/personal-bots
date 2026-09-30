import { perfOptimizationOn } from "~/features/personal/perfFlags";

/** How long one environment descriptor answer is reused. */
export const DESCRIPTOR_REUSE_MS = 2_000;
const DESCRIPTOR_PATH = "/.well-known/t3/environment";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/**
 * At boot the environment descriptor is read twice about 100 ms apart: once
 * to register the primary connection, once when that connection is prepared.
 * Both reads ask the same server for the same public document, so the second
 * one reuses the first answer while it is under DESCRIPTOR_REUSE_MS old.
 * Only a successful answer is reused (each caller gets its own clone); a
 * failure, any other path or method, and anything after the window go to the
 * network as before. The descriptor is public metadata: no credential or
 * session check depends on this. Kill switch: bots:perf-off = descriptor-reuse.
 */
export function withDescriptorReuse(fetchImpl: Fetch, now: () => number = Date.now): Fetch {
  const recent = new Map<string, { readonly at: number; readonly response: Promise<Response> }>();
  return (input, init) => {
    const url = requestUrl(input);
    if (
      requestMethod(input, init) !== "GET" ||
      !new URL(url, "http://base.invalid").pathname.endsWith(DESCRIPTOR_PATH) ||
      !perfOptimizationOn("descriptor-reuse")
    ) {
      return fetchImpl(input, init);
    }
    const hit = recent.get(url);
    if (hit !== undefined && now() - hit.at < DESCRIPTOR_REUSE_MS) {
      return hit.response.then((response) => response.clone());
    }
    const response = fetchImpl(input, init);
    const entry = { at: now(), response };
    recent.set(url, entry);
    response.then(
      (value) => {
        if (!value.ok && recent.get(url) === entry) recent.delete(url);
      },
      () => {
        if (recent.get(url) === entry) recent.delete(url);
      },
    );
    return response.then((value) => (value.ok ? value.clone() : value));
  };
}
