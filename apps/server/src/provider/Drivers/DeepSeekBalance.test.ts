import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEEPSEEK_BALANCE_CACHE_MS,
  DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS,
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_BALANCE_URL_ENV,
  deepSeekBalanceEndpoint,
  makeDeepSeekBalanceReader,
  parseDeepSeekBalance,
} from "./DeepSeekBalance.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The real shape, with a CNY row first, as DeepSeek orders its own rows. */
const USD_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "88.00",
      granted_balance: "0.00",
      topped_up_balance: "88.00",
    },
    {
      currency: "USD",
      total_balance: "12.34",
      granted_balance: "2.00",
      topped_up_balance: "10.34",
    },
  ],
};

/** A reader whose clock the test controls, so cache windows are exact. */
function harness(input: { fetchImpl: typeof fetch; startMs?: number }) {
  let nowMs = input.startMs ?? 1_000_000;
  return {
    reader: makeDeepSeekBalanceReader({ fetchImpl: input.fetchImpl, now: () => nowMs }),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseDeepSeekBalance", () => {
  it("prefers the USD row and reads the decimal strings", () => {
    expect(parseDeepSeekBalance(USD_BODY)).toEqual({
      currency: "USD",
      totalBalance: 12.34,
      grantedBalance: 2,
      toppedUpBalance: 10.34,
      isAvailable: true,
    });
  });

  it("shows a CNY-only account in CNY, never converted", () => {
    expect(
      parseDeepSeekBalance({
        is_available: false,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "6.00",
            granted_balance: "1.50",
            topped_up_balance: "4.50",
          },
        ],
      }),
    ).toEqual({
      currency: "CNY",
      totalBalance: 6,
      grantedBalance: 1.5,
      toppedUpBalance: 4.5,
      isAvailable: false,
    });
  });

  it("rejects a body with no usable balance rather than inventing zeros", () => {
    expect(parseDeepSeekBalance(null)).toBeNull();
    expect(parseDeepSeekBalance({ is_available: true })).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(
      parseDeepSeekBalance({ balance_infos: [{ currency: "", total_balance: "1.00" }] }),
    ).toBeNull();
    expect(
      parseDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "not a number" }] }),
    ).toBeNull();
  });
});

describe("deepSeekBalanceEndpoint", () => {
  it("falls back to DeepSeek's own endpoint and honours the test override", () => {
    expect(deepSeekBalanceEndpoint({})).toBe(DEEPSEEK_BALANCE_URL);
    expect(
      deepSeekBalanceEndpoint({ [DEEPSEEK_BALANCE_URL_ENV]: " http://127.0.0.1:9/stub " }),
    ).toBe("http://127.0.0.1:9/stub");
  });
});

describe("makeDeepSeekBalanceReader", () => {
  it("asks with the key as a bearer token and parses a USD reading", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(USD_BODY));
    const { reader } = harness({ fetchImpl });

    const read = await reader.read("secret-key");

    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.amounts.currency).toBe("USD");
    expect(read.amounts.totalBalance).toBe(12.34);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(DEEPSEEK_BALANCE_URL);
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-key");
  });

  it("reads the endpoint override on every call", async () => {
    vi.stubEnv(DEEPSEEK_BALANCE_URL_ENV, "http://127.0.0.1:1234/stub-balance");
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(USD_BODY));
    const { reader } = harness({ fetchImpl });

    await reader.read("secret-key");

    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:1234/stub-balance");
  });

  it("refuses to ask without a key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(USD_BODY));
    const { reader } = harness({ fetchImpl });

    expect(await reader.read("   ")).toEqual({
      status: "failed",
      reason: "missing_key",
      lastGood: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an HTTP error quietly, without reading or echoing the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("unauthorized: bad key sk-live-xyz", { status: 401 }),
    );
    const { reader } = harness({ fetchImpl });

    const read = await reader.read("secret-key");

    expect(read).toEqual({ status: "failed", reason: "http_error", lastGood: null });
    expect(JSON.stringify(read)).not.toContain("sk-live-xyz");
  });

  it("tells a timeout from a network failure and from an unreadable body", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const { reader: timedOut } = harness({
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw timeout;
      }),
    });
    expect(await timedOut.read("k")).toMatchObject({ reason: "timeout" });

    const { reader: offline } = harness({
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.deepseek.com");
      }),
    });
    expect(await offline.read("k")).toMatchObject({ reason: "network_error" });

    const { reader: garbled } = harness({
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("<html>nope</html>")),
    });
    expect(await garbled.read("k")).toMatchObject({ reason: "invalid_response" });
  });

  it("serves a reading from the cache for ten minutes, then asks again", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(USD_BODY));
    const { reader, advance } = harness({ fetchImpl });

    await reader.read("k");
    advance(DEEPSEEK_BALANCE_CACHE_MS - 1);
    const cached = await reader.read("k");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.status).toBe("ready");

    advance(2);
    await reader.read("k");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good reading through a failure and does not ask again inside the retry window", async () => {
    let fail = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (fail) return new Response("nope", { status: 500 });
      return jsonResponse(USD_BODY);
    });
    const { reader, advance } = harness({ fetchImpl });

    const first = await reader.read("k");
    expect(first.status).toBe("ready");

    // The cached reading aged out; the next ask fails.
    fail = true;
    advance(DEEPSEEK_BALANCE_CACHE_MS + 1);
    const stale = await reader.read("k");
    expect(stale.status).toBe("failed");
    if (stale.status !== "failed") return;
    // The last good reading rides the failure so the card can keep showing it.
    expect(stale.lastGood?.amounts.totalBalance).toBe(12.34);

    // Inside the retry window the failure is served, not re-asked.
    advance(DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS - 1);
    expect(await reader.read("k")).toMatchObject({ status: "failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Past it, one more attempt is made.
    advance(2);
    expect(await reader.read("k")).toMatchObject({ status: "failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never carries one key's numbers into another key's failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(USD_BODY));
    const { reader } = harness({ fetchImpl });

    expect((await reader.read("k")).status).toBe("ready");

    // Another instance (another key) asks and cannot be read: its card must
    // not be shown the first account's balance.
    const failing = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));
    const { reader: other } = harness({ fetchImpl: failing });
    expect(await other.read("other-key")).toMatchObject({
      status: "failed",
      reason: "http_error",
      lastGood: null,
    });
  });
});
