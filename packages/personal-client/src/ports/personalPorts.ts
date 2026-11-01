import type { BlobStore } from "./blobStore.ts";
import type { Clock } from "./clock.ts";
import type { Confirm } from "./confirm.ts";
import type { Ids } from "./ids.ts";
import type { KeyValueStore } from "./keyValueStore.ts";
import type { Lifecycle } from "./lifecycle.ts";

export interface PersonalPorts<BlobPayload> {
  readonly kv: KeyValueStore;
  readonly blobs: BlobStore<BlobPayload>;
  readonly clock: Clock;
  readonly lifecycle: Lifecycle;
  readonly confirm: Confirm;
  readonly ids: Ids;
}
