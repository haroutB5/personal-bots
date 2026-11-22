// @effect-diagnostics nodeBuiltinImport:off -- exclusive copy and streaming hashes are filesystem boundaries missing from Effect's API.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type AttachmentCreateUploadUrlInput,
  AttachmentUploadSigningKeyError,
} from "@t3tools/contracts";
import { isSvgAttachment } from "@t3tools/shared/image";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as AssetSigner from "./AssetSigner.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { isVideoFile } from "../provider/videoFrames/videoAnalysis.ts";
import { ensureVideoFrames, videoFramesDir } from "../provider/videoFrames/VideoFrames.ts";

export const ATTACHMENT_UPLOAD_ROUTE_PREFIX = "/api/attachments/upload";

const PENDING_ATTACHMENT_SWEEP_INTERVAL_MS = 15 * 60_000;
const lastPendingSweepByDirectory = new Map<string, number>();

const AttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  type: Schema.Literals(["image", "file"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("image" as const)),
  ),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type AttachmentUploadClaims = typeof AttachmentUploadClaims.Type;

const attachmentUploadClaimsJson = Schema.fromJsonString(AttachmentUploadClaims);
const decodeAttachmentUploadClaims = Schema.decodeUnknownOption(attachmentUploadClaimsJson);
const encodeAttachmentUploadClaims = Schema.encodeSync(attachmentUploadClaimsJson);

function decodeClaims(encodedPayload: string): AttachmentUploadClaims | null {
  try {
    return Option.getOrNull(decodeAttachmentUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export const issueAttachmentUploadUrl = Effect.fn("AttachmentUpload.issueUrl")(function* (
  input: AttachmentCreateUploadUrlInput,
) {
  const config = yield* ServerConfig.ServerConfig;
  const nowMs = yield* Clock.currentTimeMillis;
  const previousSweep = lastPendingSweepByDirectory.get(config.attachmentsDir);
  if (
    previousSweep === undefined ||
    nowMs - previousSweep >= PENDING_ATTACHMENT_SWEEP_INTERVAL_MS
  ) {
    lastPendingSweepByDirectory.set(config.attachmentsDir, nowMs);
    const swept = sweepStalePendingAttachments({
      attachmentsDir: config.attachmentsDir,
      nowMs,
    });
    if (swept.deleted > 0) {
      yield* Effect.logInfo("Removed expired attachment uploads.", { deleted: swept.deleted });
    }
  }

  const attachmentType = input.type ?? "image";
  const name =
    attachmentType === "file" && isSvgAttachment(input) && !/\.svg$/i.test(input.name)
      ? `${input.name}.svg`
      : input.name;
  const attachmentId = createPendingAttachmentId(
    attachmentType === "file" ? attachmentFileExtension(name) : undefined,
  );
  const expiresAt = nowMs + ATTACHMENT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeAttachmentUploadClaims({
      version: 1,
      kind: "attachment-upload",
      type: attachmentType,
      attachmentId,
      name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );

  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(encodedPayload)
    .pipe(Effect.mapError((cause) => new AttachmentUploadSigningKeyError({ cause })));
  return {
    attachmentId,
    relativeUrl: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signature}`,
    expiresAt,
  };
});

/**
 * A chunked upload keeps using the URL it started with: a 200 MB video on a
 * slow link outlives the 10 minute URL, so a continuation chunk may arrive up
 * to this long after expiry. The partial file only lives an hour anyway.
 */
export const CHUNKED_UPLOAD_GRACE_MS = 60 * 60_000;

export const validateAttachmentUploadToken = Effect.fn("AttachmentUpload.validateToken")(function* (
  token: string,
  graceMs = 0,
) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) {
    return null;
  }

  const signer = yield* AssetSigner.AssetSigner;
  const verified = yield* signer.verify(encodedPayload, signature).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the attachment upload signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => false),
  );
  if (!verified) {
    return null;
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt + graceMs <= (yield* Clock.currentTimeMillis)) {
    return null;
  }
  return claims;
});

export type StoreAttachmentUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const storeAttachmentUpload = Effect.fn("AttachmentUpload.store")(function* (
  claims: AttachmentUploadClaims,
  body: Uint8Array | HttpServerRequest.HttpServerRequest["stream"],
) {
  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${body.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreAttachmentUploadResult;
  }

  const config = yield* ServerConfig.ServerConfig;
  const extension =
    claims.type === "file"
      ? attachmentFileExtension(claims.name)
      : inferImageExtension({ mimeType: claims.mimeType, fileName: claims.name });
  const relativePath = `${claims.attachmentId}${extension}`;
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath,
  });
  const random = yield* SecureRandom.SecureRandom;
  const partId = yield* random.uuidV4();
  const partPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${relativePath}.${partId}.part`,
  });
  if (!finalPath || !partPath) {
    return { ok: false, status: 500, detail: "Failed to resolve attachment path." };
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let receivedBytes = 0;
  const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body;
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
    yield* Stream.run(
      bodyStream.pipe(
        Stream.takeWhile((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    );
    if (receivedBytes !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${receivedBytes} bytes, expected ${claims.sizeBytes}.`,
      } satisfies StoreAttachmentUploadResult;
    }
    // Publishing without replacement keeps an upload and its cached text immutable.
    const published = yield* fileSystem.link(partPath, finalPath).pipe(
      Effect.as(true),
      Effect.catch((error) => {
        if (error.reason._tag === "AlreadyExists") return Effect.succeed(false);
        return Effect.tryPromise({
          try: () => NodeFSP.copyFile(partPath, finalPath, NodeFSP.constants.COPYFILE_EXCL),
          catch: (cause) =>
            PlatformError.systemError({
              _tag:
                cause instanceof Error && "code" in cause && cause.code === "EEXIST"
                  ? "AlreadyExists"
                  : "Unknown",
              module: "FileSystem",
              method: "copyFile",
              pathOrDescriptor: finalPath,
              cause,
            }),
        }).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
        );
      }),
    );
    if (!published) {
      if (Number((yield* fileSystem.stat(finalPath)).size) !== receivedBytes) {
        return { ok: false, status: 409, detail: "Attachment already uploaded." };
      }
      const hashes = yield* Effect.forEach([partPath, finalPath], (file) =>
        fileSystem.stream(file).pipe(
          Stream.runFold(
            () => NodeCrypto.createHash("sha256"),
            (hash, chunk) => hash.update(chunk),
          ),
          Effect.map((hash) => hash.digest("hex")),
        ),
      );
      if (hashes[0] !== hashes[1]) {
        return { ok: false, status: 409, detail: "Attachment already uploaded." };
      }
    }
    const documents = yield* DocumentText.DocumentText;
    yield* documents.ensure(finalPath);
    if (claims.type === "file" && isVideoFile(claims)) {
      // Frames are ready by the time the message is sent; the upload does not wait.
      yield* Effect.sync(() => void ensureVideoFrames(finalPath).catch(() => undefined));
    }
    return { ok: true } satisfies StoreAttachmentUploadResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to persist attachment upload.", {
        attachmentId: claims.attachmentId,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        } satisfies StoreAttachmentUploadResult),
      ),
    ),
    Effect.ensuring(
      fileSystem.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});

export const ATTACHMENT_UPLOAD_RECEIVED_HEADER = "x-hbots-upload-received";

export type StoreAttachmentChunkResult =
  | { readonly ok: true; readonly received: number; readonly complete: boolean }
  | {
      readonly ok: false;
      readonly status: number;
      readonly detail: string;
      /** Bytes the server holds, so the client resumes from there. */
      readonly received?: number;
    };

const chunkWriters = new Set<string>();

/**
 * Appends one chunk (the tunnel caps bodies at 100 MB). A wrong offset is refused with the size
 * already held so the client resumes; the last chunk publishes like a single-request upload.
 */
export const storeAttachmentUploadChunk = Effect.fn("AttachmentUpload.storeChunk")(function* (
  claims: AttachmentUploadClaims,
  offset: number,
  length: number,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset + length > claims.sizeBytes
  ) {
    return {
      ok: false,
      status: 400,
      detail: "Chunk is outside the upload.",
    } satisfies StoreAttachmentChunkResult;
  }
  const config = yield* ServerConfig.ServerConfig;
  const extension =
    claims.type === "file"
      ? attachmentFileExtension(claims.name)
      : inferImageExtension({ mimeType: claims.mimeType, fileName: claims.name });
  const relativePath = `${claims.attachmentId}${extension}`;
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath,
  });
  const partPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${relativePath}.chunked.part`,
  });
  if (!finalPath || !partPath) {
    return { ok: false, status: 500, detail: "Failed to resolve attachment path." };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sizeOf = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => null),
    );
  if ((yield* sizeOf(finalPath)) === claims.sizeBytes) {
    return {
      ok: true,
      received: claims.sizeBytes,
      complete: true,
    } satisfies StoreAttachmentChunkResult;
  }
  if (chunkWriters.has(partPath)) {
    return {
      ok: false,
      status: 409,
      detail: "Another chunk of this upload is still being written.",
    };
  }
  chunkWriters.add(partPath);
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
    const held = offset === 0 ? 0 : ((yield* sizeOf(partPath)) ?? 0);
    if (held !== offset) {
      return {
        ok: false,
        status: 409,
        detail: `Expected the chunk at offset ${held}.`,
        received: held,
      } satisfies StoreAttachmentChunkResult;
    }
    let chunkBytes = 0;
    yield* Stream.run(
      body.pipe(
        Stream.takeWhile((chunk) => {
          chunkBytes += chunk.byteLength;
          return chunkBytes <= length;
        }),
      ),
      fileSystem.sink(partPath, { flag: offset === 0 ? "w" : "a" }),
    );
    if (chunkBytes !== length) {
      // Drop the torn tail so the next attempt can resume at this offset.
      yield* Effect.tryPromise(() => NodeFSP.truncate(partPath, offset)).pipe(Effect.ignore);
      return {
        ok: false,
        status: 400,
        detail: `Chunk was ${chunkBytes} bytes, expected ${length}.`,
        received: offset,
      } satisfies StoreAttachmentChunkResult;
    }
    const received = offset + length;
    if (received < claims.sizeBytes) {
      return { ok: true, received, complete: false } satisfies StoreAttachmentChunkResult;
    }
    const published = yield* fileSystem.rename(partPath, finalPath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!published) return { ok: false, status: 500, detail: "Failed to persist upload." };
    const documents = yield* DocumentText.DocumentText;
    yield* documents.ensure(finalPath);
    if (claims.type === "file" && isVideoFile(claims)) {
      yield* Effect.sync(() => void ensureVideoFrames(finalPath).catch(() => undefined));
    }
    return { ok: true, received, complete: true } satisfies StoreAttachmentChunkResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to persist attachment upload chunk.", {
        attachmentId: claims.attachmentId,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        } satisfies StoreAttachmentChunkResult),
      ),
    ),
    Effect.ensuring(Effect.sync(() => chunkWriters.delete(partPath))),
  );
});

export const deletePendingAttachment = Effect.fn("AttachmentUpload.deletePending")(function* (
  attachmentId: string,
) {
  if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return;
  }

  const config = yield* ServerConfig.ServerConfig;
  const attachmentPath = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId,
  });
  if (!attachmentPath) {
    return;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.orElseSucceed(() => {}));
  yield* fileSystem.remove(`${attachmentPath}.txt`, { force: true }).pipe(Effect.ignore);
  yield* fileSystem
    .remove(videoFramesDir(attachmentPath), { recursive: true, force: true })
    .pipe(Effect.ignore);
});
