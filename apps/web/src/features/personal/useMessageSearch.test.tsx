import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MESSAGE_SEARCH_DEBOUNCE_MS } from "./chatSearch";
import { useMessageSearch, type MessageSearchState } from "./useMessageSearch";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({ name: "search" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.search,
}));

const ENV = "env-1" as EnvironmentId;
let renderer: ReactTestRenderer | undefined;
let latest: MessageSearchState;

function Probe({ environmentId, query }: { environmentId: EnvironmentId | null; query: string }) {
  latest = useMessageSearch(environmentId, query);
  return null;
}

async function show(query: string, environmentId: EnvironmentId | null = ENV) {
  await act(async () => {
    const element = <Probe environmentId={environmentId} query={query} />;
    if (renderer === undefined) renderer = create(element);
    else renderer.update(element);
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const hit = (messageId: string) => ({
  threadId: `thread-${messageId}`,
  botId: "bot-1",
  groupId: null,
  messageId,
  role: "assistant",
  snippet: "x",
  createdAt: new Date(0),
  archived: false,
  moreInChat: 0,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.search.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stays idle and asks nothing for a query that is too short", async () => {
  await show("a");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS * 2);
  expect(latest).toEqual({ status: "idle", hits: [], capped: false });
  expect(mocks.search).not.toHaveBeenCalled();
});

it("stays idle without an environment", async () => {
  await show("abc", null);
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS * 2);
  expect(latest.status).toBe("idle");
  expect(mocks.search).not.toHaveBeenCalled();
});

it("waits for a pause in typing, then asks once with the trimmed query", async () => {
  mocks.search.mockResolvedValue({ _tag: "Success", value: { hits: [hit("m1")], capped: true } });
  await show("ab");
  expect(latest.status).toBe("loading");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS - 50);
  await show(" abc ");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS - 50);
  expect(mocks.search).not.toHaveBeenCalled();
  await wait(50);
  expect(mocks.search).toHaveBeenCalledTimes(1);
  expect(mocks.search).toHaveBeenCalledWith({ environmentId: ENV, input: { query: "abc" } });
  expect(latest.status).toBe("ready");
  expect(latest.hits.map((entry) => entry.messageId)).toEqual(["m1"]);
  expect(latest.capped).toBe(true);
});

it("ignores the answer to a query that has been replaced", async () => {
  const first = deferred<unknown>();
  mocks.search.mockReturnValueOnce(first.promise);
  mocks.search.mockResolvedValueOnce({
    _tag: "Success",
    value: { hits: [hit("new")], capped: false },
  });
  await show("old");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(mocks.search).toHaveBeenCalledTimes(1);
  await show("newer");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(latest.hits.map((entry) => entry.messageId)).toEqual(["new"]);
  await act(async () =>
    first.resolve({ _tag: "Success", value: { hits: [hit("old")], capped: false } }),
  );
  expect(latest.hits.map((entry) => entry.messageId)).toEqual(["new"]);
});

it("ignores a late answer once the query is cleared", async () => {
  const first = deferred<unknown>();
  mocks.search.mockReturnValueOnce(first.promise);
  await show("old");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  await show("");
  await act(async () =>
    first.resolve({ _tag: "Success", value: { hits: [hit("old")], capped: false } }),
  );
  expect(latest).toEqual({ status: "idle", hits: [], capped: false });
});

it("clears the hits when the query becomes too short", async () => {
  mocks.search.mockResolvedValue({ _tag: "Success", value: { hits: [hit("m1")], capped: false } });
  await show("abc");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(latest.hits).toHaveLength(1);
  await show("a");
  expect(latest).toEqual({ status: "idle", hits: [], capped: false });
});

it("a failure is quiet: error status, no hits, no throw", async () => {
  mocks.search.mockResolvedValueOnce({
    _tag: "Success",
    value: { hits: [hit("m1")], capped: false },
  });
  await show("abc");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(latest.hits).toHaveLength(1);

  mocks.search.mockResolvedValueOnce({ _tag: "Failure" });
  await show("abcd");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(latest).toEqual({ status: "error", hits: [], capped: false });

  mocks.search.mockRejectedValueOnce(new Error("boom"));
  await show("abcde");
  await wait(MESSAGE_SEARCH_DEBOUNCE_MS);
  expect(latest).toEqual({ status: "error", hits: [], capped: false });
});
