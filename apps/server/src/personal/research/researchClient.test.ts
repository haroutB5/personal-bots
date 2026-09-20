import { describe, expect, it, vi } from "vite-plus/test";
import { createResearchClient, publicResearchUrl } from "./researchClient.ts";

const reply = (results: unknown[]) =>
  new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });

describe("public research", () => {
  it("deduplicates overlapping requests but never reuses a completed price check", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = createResearchClient(fetcher);
    const first = client.search("bot", "secret", ["camera", "camera"], {});
    const second = client.search("bot", "secret", ["camera"], {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(reply([{ url: "https://shop.example/camera", title: "Camera", content: "Offer" }]));
    expect(await first).toEqual(await second);
    fetcher.mockResolvedValue(reply([]));
    await client.search("bot", "secret", ["camera"], {});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("limits concurrency globally across bots while preserving partial successes", async () => {
    const waiting: Array<(response: Response) => void> = [];
    const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => waiting.push(resolve)));
    const client = createResearchClient(fetcher);
    const first = client.read(
      "a",
      "key",
      [1, 2, 3, 4].map((id) => `https://example.com/${id}`),
    );
    const second = client.read("b", "key", ["https://example.com/5"]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    waiting.shift()!(new Response("secret must not leak", { status: 429 }));
    // Await the first batch rather than use a timed polling loop.
    for (const finish of waiting.splice(0))
      finish(reply([{ url: "https://example.com/read", raw_content: "Evidence" }]));
    const results = await first;
    expect(fetcher).toHaveBeenCalledTimes(5);
    waiting.shift()!(reply([{ url: "https://example.com/5", raw_content: "More evidence" }]));
    await second;
    expect(results[0]?.error).toContain("429");
    expect(JSON.stringify(results)).not.toContain("secret must not leak");
    expect(results.slice(1).every((row) => row.sources[0]?.content === "Evidence")).toBe(true);
  });

  it("isolates different credentials and bot scopes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply([]));
    const client = createResearchClient(fetcher);
    await Promise.all([
      client.search("a", "key1", ["same"], {}),
      client.search("a", "key2", ["same"], {}),
      client.search("b", "key1", ["same"], {}),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps shopping candidates unverified and missing costs unknown", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            shopping_results: [
              {
                title: "Camera",
                product_link: "https://shop.example/camera",
                price: "£90",
                source: "Shop",
              },
            ],
          }),
        ),
    );
    const result = await createResearchClient(fetcher).products("bot", "key", "camera", "uk");
    expect(result.sources[0]).toMatchObject({
      price: "£90",
      delivery: null,
      publishedAt: null,
      evidence: "shopping-listing",
    });
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("no_cache")).toBe("true");
  });

  it("bounds source text, removes duplicates, and rejects non-web links", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply([
        { url: "https://example.com/a#one", raw_content: "x".repeat(20000) },
        { url: "https://example.com/a#two", raw_content: "duplicate" },
        { url: "javascript:alert(1)", raw_content: "bad" },
      ]),
    );
    const [result] = await createResearchClient(fetcher).read("bot", "key", [
      "https://example.com/a",
    ]);
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]?.content).toHaveLength(12000);
    expect(result?.sources[0]?.truncated).toBe(true);
  });

  it("rejects oversized responses and releases the request slot", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("x".repeat(2_000_001)))
      .mockResolvedValueOnce(reply([]));
    const client = createResearchClient(fetcher);
    const [failed] = await client.search("bot", "key", ["query"], {});
    expect(failed?.error).not.toBeNull();
    const [retried] = await client.search("bot", "key", ["query"], {});
    expect(retried?.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not report an empty extracted page as successful evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply([{ url: "https://example.com/empty", raw_content: "" }]),
    );
    const [result] = await createResearchClient(fetcher).read("bot", "key", [
      "https://example.com/empty",
    ]);
    expect(result?.error).toContain("extraction failed");
  });

  it("returns a failure rather than inventing results for malformed responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"oops":true}'));
    const [result] = await createResearchClient(fetcher).search("bot", "key", ["query"], {});
    expect(result?.error).not.toBeNull();
    expect(result?.sources).toEqual([]);
  });

  it.each([
    "file:///etc/passwd",
    "http://127.0.0.1/a",
    "http://[::1]/",
    "http://localhost/",
    "https://router.local/a",
    "https://user:pass@example.com/",
    "https://example.com/?token=private",
    "https://example.com:8080/",
  ])("refuses private or credential-bearing URLs: %s", async (url) => {
    expect(publicResearchUrl(url)).toBeNull();
    const fetcher = vi.fn<typeof fetch>();
    const [result] = await createResearchClient(fetcher).read("bot", "key", [url]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result?.error).not.toBeNull();
  });
});
