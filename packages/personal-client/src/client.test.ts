import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import { type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { createPersonalClient, type PersonalHost } from "./client.ts";
import {
  createFakeConfirm,
  createFakeLifecycle,
  createManualClock,
  createMemoryBlobStore,
  createMemoryKeyValueStore,
  createSequentialIds,
} from "./testing/fakes.ts";

const ACTIVE = "env-active" as EnvironmentId;
const PRIMARY = "env-primary" as EnvironmentId;

const host: PersonalHost = {
  useActiveEnvironmentId: () => ACTIVE,
  usePrimaryEnvironmentId: () => PRIMARY,
};

function makeClient() {
  const ports = {
    kv: createMemoryKeyValueStore({ greeting: "hello" }),
    blobs: createMemoryBlobStore<string>((payload) => payload.length),
    clock: createManualClock(5_000),
    lifecycle: createFakeLifecycle("background"),
    confirm: createFakeConfirm([true]),
    ids: createSequentialIds(),
  };
  const runtime = Atom.runtime(Layer.empty);
  return { ports, client: createPersonalClient(runtime, ports, host) };
}

describe("createPersonalClient", () => {
  it("hands back the ports and host it was given", async () => {
    const { client } = makeClient();
    expect(client.ports.kv.getItem("greeting")).toBe("hello");
    expect(client.ports.clock.now()).toBe(5_000);
    expect(client.ports.lifecycle.current()).toBe("background");
    expect(client.ports.ids.randomUUID()).toBe("00000000-0000-4000-8000-000000000001");
    expect(await client.ports.confirm.confirm({ title: "Delete", destructive: true })).toBe(true);
    expect([client.host.useActiveEnvironmentId(), client.host.usePrimaryEnvironmentId()]).toEqual([
      "env-active",
      "env-primary",
    ]);
  });

  it("reads an atom from its runtime through useEnvironmentQuery", () => {
    const { client } = makeClient();
    const answer = client.runtime.atom(Effect.succeed(7));
    const Probe = () => {
      const view = client.useEnvironmentQuery(answer);
      return createElement(
        "span",
        null,
        `data=${view.data} success=${view.isSuccess} error=${view.error}`,
      );
    };
    expect(renderToString(createElement(Probe))).toBe(
      "<span>data=7 success=true error=null</span>",
    );
  });

  it("shows no data for a missing atom", () => {
    const { client } = makeClient();
    const Probe = () => {
      const view = client.useEnvironmentQuery(null);
      return createElement("span", null, `data=${view.data} pending=${view.isPending}`);
    };
    expect(renderToString(createElement(Probe))).toBe("<span>data=null pending=false</span>");
  });

  it("runs a command through useAtomCommand and returns its settled result", async () => {
    const { client } = makeClient();
    const double: AtomCommand<number, number, never> = {
      label: "double",
      run: async (_registry, input) => AsyncResult.success(input * 2),
    };
    let run: ((value: number) => Promise<AsyncResult.AsyncResult<number, never>>) | null = null;
    const Probe = () => {
      run = client.useAtomCommand(double);
      return null;
    };
    renderToString(createElement(Probe));
    const result = await run!(21);
    expect(result._tag).toBe("Success");
    expect(AsyncResult.isSuccess(result) ? result.value : null).toBe(42);
  });
});
