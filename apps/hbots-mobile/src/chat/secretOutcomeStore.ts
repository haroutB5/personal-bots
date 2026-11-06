import type { SecretRequestHistoryEntry } from "@hbots/personal-client/conversation/secretRequestCards";
import { Directory, File, Paths } from "expo-file-system";

import { decodeSecretOutcomeHistory, encodeSecretOutcomeHistory } from "./secretOutcomeModel";

const DIRECTORY = "hbots-chat-cards";

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function fileFor(environmentId: string): File {
  const root = new Directory(Paths.document, DIRECTORY);
  if (!root.exists) root.create({ intermediates: true });
  return new File(root, `secret-outcomes-${safeKey(environmentId)}.json`);
}

/**
 * A settled card's receipt, kept per environment so reopening the chat shows
 * what this device did. Only request metadata is stored; the secret value never
 * enters this file.
 */
export function readSecretOutcomeHistory(environmentId: string): SecretRequestHistoryEntry[] {
  try {
    const file = fileFor(environmentId);
    if (!file.exists) return [];
    return decodeSecretOutcomeHistory(JSON.parse(file.textSync()));
  } catch {
    return [];
  }
}

export function writeSecretOutcomeHistory(
  environmentId: string,
  history: ReadonlyArray<SecretRequestHistoryEntry>,
): void {
  try {
    fileFor(environmentId).write(encodeSecretOutcomeHistory(history));
  } catch {
    // A receipt that cannot be written must not stop the chat from rendering.
  }
}
