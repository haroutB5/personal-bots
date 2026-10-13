import type { JSX } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WS_METHODS } from "@t3tools/contracts";

/*
 * The home's open sign-ins come from one machine-wide RPC since 1.67.0
 * (`personalLoginRequests.listPending`): no per-chat asks, no tasks feed, and
 * a sign-in in a plain chat counts. These cases pin the wiring the home
 * relies on; ChatsScreen.test proves the pill it produces.
 */

const calls = vi.hoisted(() => ({
  family: [] as Array<{ options: { tag: string }; input: unknown }>,
  query: { data: undefined as unknown },
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcQueryAtomFamily: (_runtime: unknown, options: { tag: string }) => {
    return (args: { environmentId: unknown; input: unknown }) => {
      calls.family.push({ options, input: args });
      return { label: "atom" };
    };
  },
}));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => (atom === null ? { data: undefined } : calls.query),
}));

import { useNeedsYouLoginRequests } from "./useNeedsYouLoginRequests";

function Probe({ environmentId }: { readonly environmentId: string | null }): JSX.Element {
  const ids = useNeedsYouLoginRequests(environmentId as never).map((request) => request.requestId);
  return <span>{ids.join(",")}</span>;
}

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe("useNeedsYouLoginRequests", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    calls.family.length = 0;
    calls.query = { data: undefined };
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("asks the machine-wide pending RPC, with no chat to name", () => {
    act(() => {
      renderer = create(<Probe environmentId="env-1" />);
    });
    expect(calls.family).toHaveLength(1);
    expect(calls.family[0]!.options.tag).toBe(WS_METHODS.personalLoginRequestsListPending);
    expect(calls.family[0]!.input).toEqual({ environmentId: "env-1", input: {} });
  });

  it("returns only the still-open requests", () => {
    calls.query = {
      data: {
        requests: [
          { requestId: "open-1", status: "pending" },
          { requestId: "open-2", status: "filling" },
          { requestId: "done", status: "filled" },
          { requestId: "gone", status: "expired" },
        ],
      },
    };
    act(() => {
      renderer = create(<Probe environmentId="env-1" />);
    });
    expect(text(renderer!)).toContain("open-1,open-2");
    expect(text(renderer!)).not.toContain("done");
    expect(text(renderer!)).not.toContain("gone");
  });

  it("asks nothing at all without an environment", () => {
    calls.query = { data: { requests: [{ requestId: "open-1", status: "pending" }] } };
    act(() => {
      renderer = create(<Probe environmentId={null} />);
    });
    expect(calls.family).toHaveLength(0);
    expect(text(renderer!)).not.toContain("open-1");
  });
});
