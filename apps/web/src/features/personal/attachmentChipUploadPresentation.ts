import type { EnvironmentId } from "@t3tools/contracts";

import type { AttachmentUploadState } from "~/lib/attachmentUploadState";
import { formatAttachmentUploadProgress } from "~/lib/attachmentUploadState";

export type AttachmentChipUploadPresentation =
  | { readonly status: "pending" }
  | { readonly status: "uploading"; readonly progressLabel: string }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

/** Keeps stale upload state from another environment off the current draft's chip. */
export function attachmentChipUploadPresentation(
  upload: AttachmentUploadState | undefined,
  environmentId: EnvironmentId,
): AttachmentChipUploadPresentation {
  if (upload === undefined || upload.environmentId !== environmentId) {
    return { status: "pending" };
  }
  switch (upload.status) {
    case "uploading":
      return {
        status: "uploading",
        progressLabel: formatAttachmentUploadProgress(upload.progress),
      };
    case "ready":
      return { status: "ready" };
    case "failed":
      return { status: "failed", reason: upload.reason };
  }
}
