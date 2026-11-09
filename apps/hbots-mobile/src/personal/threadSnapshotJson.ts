import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const decodeThreadSnapshotJson = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);
