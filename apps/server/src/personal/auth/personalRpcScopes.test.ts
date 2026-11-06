import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsPersonalRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { PERSONAL_RPC_REQUIRED_SCOPES } from "./personalRpcScopes.ts";

describe("personal RPC authorization scopes", () => {
  it("declares exactly one scope for every personal RPC", () => {
    expect(new Set(Object.keys(PERSONAL_RPC_REQUIRED_SCOPES))).toEqual(
      new Set(WsPersonalRpcGroup.requests.keys()),
    );
  });

  it("lets a read-only session see the per-bot token totals", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.personalBotsTokenUsage)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("requires operate scope to permanently delete a personal file", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.personalFilesDelete)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("gives every bulk action the same operate scope as its single action", () => {
    for (const method of [
      WS_METHODS.personalFilesDeleteMany,
      WS_METHODS.personalMemoryDelete,
      WS_METHODS.personalMemoryDeleteMany,
      WS_METHODS.personalRoutinesDelete,
      WS_METHODS.personalRoutinesDeleteMany,
      WS_METHODS.personalRoutinesPause,
      WS_METHODS.personalRoutinesSetEnabledMany,
      WS_METHODS.personalLoginsDelete,
      WS_METHODS.personalLoginsDeleteMany,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps connection management owner-operated while allowing safe listing", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.personalConnectionsList)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.personalConnectionsConnect,
      WS_METHODS.personalConnectionsValidate,
      WS_METHODS.personalConnectionsDisable,
      WS_METHODS.personalConnectionsReconnect,
      WS_METHODS.personalConnectionsDisconnect,
      WS_METHODS.personalConnectionsRotate,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
});
