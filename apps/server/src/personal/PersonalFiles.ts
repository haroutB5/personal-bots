import {
  PersonalBotsError,
  type PersonalFile,
  type PersonalFilesListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { parseAttachmentFileExtension } from "../attachmentStore.ts";
import type { PersonalFileRecord } from "./PersonalBotService.ts";

/**
 * Signs one Files-tab row through the existing attachment asset route
 * (`/api/assets/<signed token>/<name>`). The token names the attachment id
 * only; the server re-resolves the id inside the attachments directory on
 * every request, so no host path ever reaches the client.
 *
 * `previewUrl` is minted for PDFs only, and the inline decision comes from the
 * extension the server baked into the attachment id, never the client mime.
 */
const signPersonalFile = (record: PersonalFileRecord) =>
  Effect.gen(function* () {
    const resource = {
      _tag: "attachment" as const,
      attachmentId: record.fileId,
      fileName: record.name,
      mimeType: record.mimeType,
    };
    const served = yield* issueAssetUrl({ resource });
    const preview =
      parseAttachmentFileExtension(record.fileId) === "pdf"
        ? yield* issueAssetUrl({ resource: { ...resource, disposition: "inline" as const } })
        : null;
    return {
      ...record,
      url: served.relativeUrl,
      previewUrl: preview?.relativeUrl ?? null,
      expiresAt: served.expiresAt,
    } satisfies PersonalFile;
  }).pipe(
    // Deleted between listing and signing: drop the row, keep the list.
    Effect.catchTags({ AssetAttachmentNotFoundError: () => Effect.succeed(null) }),
    Effect.mapError(
      (cause) => new PersonalBotsError({ message: "Personal files could not be signed.", cause }),
    ),
  );

export const signPersonalFiles = Effect.fn("PersonalFiles.signPersonalFiles")(function* (
  records: ReadonlyArray<PersonalFileRecord>,
) {
  const signed = yield* Effect.forEach(records, signPersonalFile, { concurrency: 4 });
  return {
    files: signed.filter((file): file is PersonalFile => file !== null),
  } satisfies PersonalFilesListResult;
});
