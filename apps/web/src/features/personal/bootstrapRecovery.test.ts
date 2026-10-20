import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PrimaryEnvironmentRequestError,
  retryTransientBootstrap,
} from "../../environments/primary/auth";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function responseError(status: number) {
  const request = HttpClientRequest.get("http://localhost/api/auth/session");
  const response = HttpClientResponse.fromWeb(request, new Response("origin failure", { status }));
  return PrimaryEnvironmentRequestError.fromCause({
    operation: "fetch-session-state",
    cause: new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request, response }),
    }),
  });
}

describe("bootstrap origin recovery", () => {
  it.each([408, 502, 503, 504, ...Array.from({ length: 11 }, (_, i) => 520 + i)])(
    "retries HTTP %i and remains recoverable after the budget",
    async (status) => {
      vi.useFakeTimers();
      const error = responseError(status);
      expect(error.status).toBe(status);
      expect(error.unreachable).toBe(true);
      const operation = vi.fn().mockRejectedValue(error);
      const result = retryTransientBootstrap(operation).catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await result).toBe(error);
      expect(operation).toHaveBeenCalledTimes(31);
    },
  );

  it.each([400, 401, 403, 404, 500, 501, 519, 531])(
    "does not hide or retry HTTP %i",
    async (status) => {
      const error = responseError(status);
      const operation = vi.fn().mockRejectedValue(error);
      await expect(retryTransientBootstrap(operation)).rejects.toBe(error);
      expect(error.unreachable).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers from a relay error on the next attempt", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce(responseError(524)).mockResolvedValue("ready");
    const result = retryTransientBootstrap(operation);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("recognizes actual Effect interruption, timeouts and aborted fetches", async () => {
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise the real runPromise rejection shape received at the HTTP boundary.
    const interrupted: unknown = await Effect.runPromise(Effect.interrupt).catch(
      (error: unknown) => error,
    );
    for (const cause of [
      interrupted,
      new Cause.TimeoutError(),
      new DOMException("timed out", "TimeoutError"),
      new DOMException("aborted", "AbortError"),
    ]) {
      expect(
        PrimaryEnvironmentRequestError.fromCause({
          operation: "fetch-environment-descriptor",
          cause,
        }).unreachable,
      ).toBe(true);
    }
  });

  it("keeps schema and programming failures visible", async () => {
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-environment-descriptor",
      cause: new Error("Invalid descriptor schema"),
    });
    expect(error.status).toBe(500);
    expect(error.unreachable).toBe(false);
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryTransientBootstrap(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("can restore the previous classification on one device", () => {
    vi.stubGlobal("localStorage", { getItem: () => "off" });
    expect(responseError(524).unreachable).toBe(false);
    expect(responseError(502).unreachable).toBe(false);
  });
});
