import {
  deleteOutboxBlobs,
  getOutboxBlob,
  putOutboxBlobs,
} from "@hbots/personal-client/composer/outboxBlobs";

import type { NativeBlob } from "../platform/nativePorts";
import type { DraftAttachment } from "./outboxNative";

/**
 * The pending send owns its files. Encrypted copies go to the app's document
 * area before the draft lets go of the intake, so an upload or a retry after a
 * force stop reads a path that still exists.
 */
export async function retainOutgoingFiles(
  messageId: string,
  attachments: ReadonlyArray<DraftAttachment>,
): Promise<boolean> {
  if (attachments.length === 0) return true;
  try {
    await putOutboxBlobs(
      messageId,
      attachments.map((attachment) => ({
        id: attachment.id,
        blob: {
          uri: attachment.uri,
          size: attachment.sizeBytes,
          mimeType: attachment.mimeType,
          name: attachment.name,
        },
      })),
    );
    return true;
  } catch {
    return false;
  }
}

export async function readableOutgoingFiles(
  messageId: string,
  attachments: ReadonlyArray<DraftAttachment>,
): Promise<ReadonlyArray<DraftAttachment> | null> {
  const readable: DraftAttachment[] = [];
  for (const attachment of attachments) {
    const blob = await getOutboxBlob<NativeBlob>(messageId, attachment.id);
    if (blob === null) return null;
    readable.push({
      ...attachment,
      uri: blob.uri,
      sizeBytes: attachment.sizeBytes > 0 ? attachment.sizeBytes : blob.size,
    });
  }
  return readable;
}

export function discardOutgoingFiles(messageId: string): Promise<boolean> {
  return deleteOutboxBlobs(messageId);
}
