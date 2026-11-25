import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { createPersonalAutomationClient } from "./automationClient.ts";

const makeClient = () =>
  createPersonalAutomationClient(
    Atom.runtime(Layer.empty) as unknown as Parameters<typeof createPersonalAutomationClient>[0],
  );

const ENV = "env-1" as EnvironmentId;

describe("refreshPersonalWorkQuestions", () => {
  it("refreshes the questions atom of the environment", () => {
    const client = makeClient();
    const refreshed: unknown[] = [];
    client.refreshPersonalWorkQuestions({ refresh: (atom) => refreshed.push(atom) }, ENV);
    expect(refreshed).toEqual([client.personalWorkQuestions({ environmentId: ENV, input: {} })]);
  });

  it("does nothing without an environment", () => {
    const client = makeClient();
    const refreshed: unknown[] = [];
    client.refreshPersonalWorkQuestions({ refresh: (atom) => refreshed.push(atom) }, null);
    expect(refreshed).toEqual([]);
  });
});

describe("shared personalTasksFeed", () => {
  it("reuses a caller-supplied personalTasksFeed atom family instead of creating a duplicate stream", () => {
    const sharedFeed = ((args: unknown) => ({ shared: true, args })) as unknown as NonNullable<
      Parameters<typeof createPersonalAutomationClient>[1]
    >["personalTasksFeed"];
    const client = createPersonalAutomationClient(
      Atom.runtime(Layer.empty) as unknown as Parameters<typeof createPersonalAutomationClient>[0],
      { personalTasksFeed: sharedFeed },
    );
    expect(client.personalTasksFeed).toBe(sharedFeed);
  });
});
