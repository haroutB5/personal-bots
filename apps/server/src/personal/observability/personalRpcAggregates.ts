import { WsPersonalRpcGroup } from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type PersonalRpcMethod = RpcGroup.Rpcs<typeof WsPersonalRpcGroup>["_tag"];

/** Trace label for every personal RPC, spread into RpcInstrumentation's exhaustive record. */
export const PERSONAL_RPC_AGGREGATES = Object.fromEntries(
  [...WsPersonalRpcGroup.requests.keys()].map((tag) => [tag, "personal"]),
) as Readonly<Record<PersonalRpcMethod, "personal">>;
