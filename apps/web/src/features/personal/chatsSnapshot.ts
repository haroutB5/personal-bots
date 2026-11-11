import {
  dropChatFromSnapshot as dropChatFromSnapshotIn,
  readChatsSnapshot as readChatsSnapshotIn,
  readChatsSnapshotBeforeEnvironment as readChatsSnapshotBeforeEnvironmentIn,
  writeChatsSnapshot as writeChatsSnapshotIn,
  type ChatsSnapshot,
  type ChatsSnapshotRow,
} from "@hbots/personal-client/bots/chatsSnapshot";

import { webKeyValueStore } from "./platform/webStorage";

export const readChatsSnapshot = (environmentId: string | null): ChatsSnapshot | null =>
  readChatsSnapshotIn(webKeyValueStore, environmentId);

export const readChatsSnapshotBeforeEnvironment = (): ChatsSnapshot | null =>
  readChatsSnapshotBeforeEnvironmentIn(webKeyValueStore);

export const writeChatsSnapshot = (environmentId: string, snapshot: ChatsSnapshot): void =>
  writeChatsSnapshotIn(webKeyValueStore, environmentId, snapshot);

export const dropChatFromSnapshot = (
  environmentId: string | null,
  predicate: (row: ChatsSnapshotRow) => boolean,
): ChatsSnapshot | null => dropChatFromSnapshotIn(webKeyValueStore, environmentId, predicate);
