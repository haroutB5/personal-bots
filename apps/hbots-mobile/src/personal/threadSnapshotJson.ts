import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Schema from "effect/Schema";

const CachedThreadSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadDetailSnapshot.fields,
  turnItemsOmitLocalVisible: Schema.optional(Schema.Literal(true)),
});

const decodeCachedSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(CachedThreadSnapshot));

export function decodeThreadSnapshotJson(value: unknown): OrchestrationV2ThreadDetailSnapshot {
  const { turnItemsOmitLocalVisible, ...snapshot } = decodeCachedSnapshot(value);
  return {
    ...snapshot,
    projection: boundedSnapshotProjection({
      projection: snapshot.projection,
      turnItemsOmitLocalVisible,
    }),
  };
}
