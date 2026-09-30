import { afterEach, expect, it, vi } from "vite-plus/test";

import { DESCRIPTOR_REUSE_MS, withDescriptorReuse } from "./descriptorReuse";

const state = vi.hoisted(() => ({ off: new Set<string>() }));
vi.mock("~/features/personal/perfFlags", () => ({
  perfOptimizationOn: (name: string) => !state.off.has(name),
}));

afterEach(() => state.off.clear());

const descriptorUrl = "http://127.0.0.1:1/.well-known/t3/environment";
const make = (status = 200) => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ environmentId: "env-1" }), { status });
  });
  let clock = 1_000;
  const fetchWith = withDescriptorReuse(fetchImpl, () => clock);
  return { calls, fetchWith, advance: (ms: number) => (clock += ms) };
};

it("reuses one descriptor answer inside the window, each caller reading its own body", async () => {
  const { calls, fetchWith, advance } = make();
  const first = await fetchWith(descriptorUrl);
  advance(100);
  const second = await fetchWith(descriptorUrl);
  expect(calls).toHaveLength(1);
  expect(await first.json()).toEqual({ environmentId: "env-1" });
  expect(await second.json()).toEqual({ environmentId: "env-1" });
});

it("asks again after the window", async () => {
  const { calls, fetchWith, advance } = make();
  await fetchWith(descriptorUrl);
  advance(DESCRIPTOR_REUSE_MS);
  await fetchWith(descriptorUrl);
  expect(calls).toHaveLength(2);
});

it("never reuses a failure, another path, or another method", async () => {
  const failing = make(503);
  await failing.fetchWith(descriptorUrl);
  await failing.fetchWith(descriptorUrl);
  expect(failing.calls).toHaveLength(2);

  const other = make();
  await other.fetchWith("http://127.0.0.1:1/api/auth/session");
  await other.fetchWith("http://127.0.0.1:1/api/auth/session");
  await other.fetchWith(descriptorUrl, { method: "POST" });
  await other.fetchWith(descriptorUrl, { method: "POST" });
  expect(other.calls).toHaveLength(4);
});

it("goes to the network every time with descriptor-reuse off", async () => {
  state.off.add("descriptor-reuse");
  const { calls, fetchWith } = make();
  await fetchWith(descriptorUrl);
  await fetchWith(descriptorUrl);
  expect(calls).toHaveLength(2);
});
