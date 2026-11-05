import { RequestFailure, type RequestRoute } from "./failure";

export const REQUEST_TIMEOUT_MS = 15_000;

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

export async function requestJson(
  route: RequestRoute,
  url: URL,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const external = init.signal ?? null;
  let timedOut = false;
  const abort = () => {
    timedOut = true;
    controller.abort();
  };
  if (external !== null) {
    if (external.aborted) abort();
    else external.addEventListener("abort", abort);
  }
  const timer = setTimeout(abort, timeoutMs);
  try {
    let text: string;
    let status: number;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      status = response.status;
      text = await response.text();
    } catch {
      throw new RequestFailure(timedOut ? { kind: "timeout" } : { kind: "network" });
    }
    if (status < 200 || status >= 300) {
      throw new RequestFailure({ kind: "http", route, status, jsonBody: isJsonObject(text) });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RequestFailure({ kind: "not-json" });
    }
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
