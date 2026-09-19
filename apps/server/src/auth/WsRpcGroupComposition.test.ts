import {
  WsPersonalRpcGroup,
  WsPullRequestRpcGroup,
  WsRpcGroup,
  WsServerRpcGroup,
  WsSessionRpcGroup,
  WsWorkspaceRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

const subGroups = {
  WsServerRpcGroup,
  WsPullRequestRpcGroup,
  WsPersonalRpcGroup,
  WsWorkspaceRpcGroup,
  WsSessionRpcGroup,
} as const;

/**
 * `RpcGroup.toLayer` resolves every handler's service requirements against the
 * whole Rpc union, so its cost is quadratic in the number of methods in the
 * group. Past roughly 215 methods in one group TypeScript exhausts its
 * per-operation instantiation budget and abandons the requirements channel,
 * which shows up as an unrelated-looking TS2345 in `bin.ts`. 180 leaves a
 * comfortable margin under that; the fix when this test fails is to add a
 * sub-group in `packages/contracts/src/rpc.ts` and a matching `toLayer` call in
 * `apps/server/src/ws.ts`, not to raise this number.
 */
const MAX_METHODS_PER_SUB_GROUP = 180;

describe("WsRpcGroup composition", () => {
  it("keeps every sub-group small enough for `toLayer` to infer", () => {
    for (const [name, group] of Object.entries(subGroups)) {
      expect(
        group.requests.size,
        `${name} has ${group.requests.size} methods; split it before adding more.`,
      ).toBeLessThanOrEqual(MAX_METHODS_PER_SUB_GROUP);
    }
  });

  it("merges the sub-groups into WsRpcGroup without losing or duplicating a method", () => {
    const fromSubGroups = Object.values(subGroups).flatMap((group) => [...group.requests.keys()]);

    // No method belongs to two sub-groups: `ws.ts` narrows one handler object
    // per sub-group, and a method in two of them would be handled twice.
    expect(new Set(fromSubGroups).size).toBe(fromSubGroups.length);
    expect(new Set(fromSubGroups)).toEqual(new Set(WsRpcGroup.requests.keys()));
  });
});
