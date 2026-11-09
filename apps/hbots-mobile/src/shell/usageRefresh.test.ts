import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  sendUsageRefresh,
  USAGE_REFRESH_FAILED_MESSAGE,
  type UsageRefreshRequest,
} from "./usageRefresh";

const environmentId = EnvironmentId.make("environment-1");

describe("usage refresh", () => {
  it("asks the server to re-read the limits instead of replaying its cached reading", async () => {
    const send = vi.fn(async (_request: UsageRefreshRequest) => AsyncResult.success(undefined));

    const failure = await sendUsageRefresh(send, environmentId);

    expect(failure).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({
      environmentId,
      input: { refreshUsage: true },
    });
  });

  it("returns the server's reason when the refresh command fails", async () => {
    const send = async () =>
      AsyncResult.failure(Cause.fail(new Error("Could not reach your laptop.")));

    expect(await sendUsageRefresh(send, environmentId)).toBe("Could not reach your laptop.");
  });

  it("uses its own wording when the server names no reason", async () => {
    const send = async () => AsyncResult.failure(Cause.fail("offline"));

    expect(await sendUsageRefresh(send, environmentId)).toBe(USAGE_REFRESH_FAILED_MESSAGE);
  });
});
