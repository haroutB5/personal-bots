import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AssetAttachmentNotFoundError,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import { signPersonalFiles } from "./PersonalFiles.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-files-test-" });

const testLayer = PersonalBotService.layer.pipe(
  Layer.provideMerge(PersonalBotRepository.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: () => Effect.succeed({ sequence: 1 }),
    } as unknown as OrchestrationEngine.OrchestrationEngineShape),
  ),
  Layer.provideMerge(
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed([]),
    } as unknown as ProviderRegistry.ProviderRegistryShape),
  ),
  Layer.provideMerge(
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getProjectShellById: () => Effect.succeed(Option.none()),
      getProjectShells: () => Effect.succeed([]),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      NodeHttpPlatform.layer,
      WorkspacePaths.layer,
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
      ServerSecretStore.layer,
    ),
  ),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const botInput = {
  botId: PersonalBotId.make("bot-files"),
  name: "Assistant",
  description: "Helps.",
  instructions: "Be helpful.",
  avatarShape: "blob" as const,
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
};

const writeAttachment = (fileName: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    const filePath = path.join(config.attachmentsDir, fileName);
    yield* fs.writeFileString(filePath, "bytes");
    return filePath;
  });

const insertMessage = (input: {
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<Record<string, unknown>>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
      ) VALUES (${input.messageId}, ${input.threadId}, 'user', 'See attached',
        ${encodeJson(input.attachments)}, 0, ${input.createdAt}, ${input.createdAt})
    `;
  });

/** Splits `/api/assets/<token>/<name>` the way the HTTP route does. */
const routeParts = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separator = suffix.indexOf("/");
  return { token: suffix.slice(0, separator), name: suffix.slice(separator + 1) };
};

const resolveUrl = (relativeUrl: string) => {
  const { token, name } = routeParts(relativeUrl);
  return resolveAsset(token, name);
};

it.effect("lists only attachments owned by personal-bot threads that still exist on disk", () =>
  Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const bot = yield* service.create(botInput);
    const threadId = ThreadId.make("thread-personal");
    yield* service.createThread({ botId: bot.botId, threadId });

    const imageId = `thread-personal-${uuid(1)}`;
    const pdfId = `thread-personal-${uuid(2)}-pdf`;
    const missingId = `thread-personal-${uuid(3)}-txt`;
    const foreignId = `thread-upstream-${uuid(4)}-txt`;
    const upstreamId = `thread-upstream-${uuid(5)}-txt`;
    const imagePath = yield* writeAttachment(`${imageId}.png`);
    const pdfPath = yield* writeAttachment(`${pdfId}.pdf`);
    yield* writeAttachment(`${foreignId}.txt`);
    yield* writeAttachment(`${upstreamId}.txt`);

    yield* insertMessage({
      messageId: "message-1",
      threadId: "thread-personal",
      createdAt: "2026-09-13T10:00:00.000Z",
      attachments: [
        { type: "image", id: imageId, name: "photo.png", mimeType: "image/png", sizeBytes: 5 },
        // Referenced but deleted from disk: not offered.
        { type: "file", id: missingId, name: "gone.txt", mimeType: "text/plain", sizeBytes: 5 },
        // Minted for another thread: not this bot's file.
        { type: "file", id: foreignId, name: "other.txt", mimeType: "text/plain", sizeBytes: 5 },
      ],
    });
    yield* insertMessage({
      messageId: "message-2",
      threadId: "thread-personal",
      createdAt: "2026-09-13T11:00:00.000Z",
      attachments: [
        { type: "file", id: pdfId, name: "report.pdf", mimeType: "application/pdf", sizeBytes: 5 },
      ],
    });
    // An upstream (non-personal) thread's attachment never appears.
    yield* insertMessage({
      messageId: "message-3",
      threadId: "thread-upstream",
      createdAt: "2026-09-13T12:00:00.000Z",
      attachments: [
        {
          type: "file",
          id: upstreamId,
          name: "upstream.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ],
    });

    const records = yield* service.listFiles();
    expect(records.map((file) => [file.fileId, file.name, file.botId, file.threadId])).toEqual([
      [pdfId, "report.pdf", bot.botId, threadId],
      [imageId, "photo.png", bot.botId, threadId],
    ]);

    const { files } = yield* signPersonalFiles(records);
    expect(files.map((file) => file.fileId)).toEqual([pdfId, imageId]);
    const [pdf, image] = files;

    // Images serve inline through the id-based route and need no preview URL.
    expect(image!.url.startsWith(`${ASSET_ROUTE_PREFIX}/`)).toBe(true);
    expect(image!.previewUrl).toBeNull();
    const servedImage = yield* resolveUrl(image!.url);
    expect(servedImage).toMatchObject({ kind: "file", path: imagePath });
    expect(servedImage).not.toHaveProperty("download");

    // Other files download with their real name; PDFs also get an inline URL.
    expect(yield* resolveUrl(pdf!.url)).toMatchObject({
      path: pdfPath,
      download: true,
      fileName: "report.pdf",
    });
    const pdfPreview = yield* resolveUrl(pdf!.previewUrl!);
    expect(pdfPreview).toMatchObject({ path: pdfPath, mimeType: "application/pdf" });
    expect(pdfPreview).not.toHaveProperty("download");

    // A deleted bot's files leave the tab with it.
    yield* service.remove({ botId: bot.botId });
    expect(yield* service.listFiles()).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("the attachment route rejects traversal, unknown and forged ids", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A private file right next to the attachments directory.
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFileString(path.join(path.dirname(config.attachmentsDir), "secret.txt"), "no");

    for (const attachmentId of [
      "../secret",
      "..\\secret",
      "../secret.txt",
      `thread-personal-${uuid(9)}`,
      "thread-personal-not-a-uuid",
    ]) {
      const error = yield* Effect.flip(
        issueAssetUrl({ resource: { _tag: "attachment", attachmentId } }),
      );
      expect(error).toBeInstanceOf(AssetAttachmentNotFoundError);
    }

    // Even a correctly signed token cannot name a path outside the directory.
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const signingSecret = yield* secrets.getOrCreateRandom("asset-access-signing-key", 32);
    const traversalPayload = base64UrlEncode(
      encodeJson({
        version: 1,
        kind: "attachment",
        attachmentId: "../secret",
        download: true,
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(
      yield* resolveAsset(
        `${traversalPayload}.${signPayload(traversalPayload, signingSecret)}`,
        "x",
      ),
    ).toBeNull();

    // A real file's signature cannot be re-used for another payload.
    const realId = `thread-personal-${uuid(10)}-txt`;
    yield* writeAttachment(`${realId}.txt`);
    const issued = yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: realId } });
    const { token, name } = routeParts(issued.relativeUrl);
    expect(yield* resolveAsset(token, name)).toMatchObject({ kind: "file" });
    const [, realSignature] = token.split(".");
    expect(yield* resolveAsset(`${traversalPayload}.${realSignature}`, name)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "permanently deletes one personal file and treats only a known missing file as idempotent",
  () =>
    Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const bot = yield* service.create(botInput);
      const threadId = ThreadId.make("thread-delete-file");
      yield* service.createThread({ botId: bot.botId, threadId });

      const fileId = `thread-delete-file-${uuid(20)}-txt`;
      const filePath = yield* writeAttachment(`${fileId}.txt`);
      yield* insertMessage({
        messageId: "message-delete-file",
        threadId,
        createdAt: "2026-09-14T10:00:00.000Z",
        attachments: [
          { type: "file", id: fileId, name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
        ],
      });

      expect((yield* service.listFiles()).map((file) => file.fileId)).toEqual([fileId]);
      yield* service.deleteFile({ fileId });
      expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(filePath)))).toBe(
        false,
      );
      expect(yield* service.listFiles()).toEqual([]);

      // The message reference remains, so a transport retry is safe.
      yield* service.deleteFile({ fileId });

      const unknownId = `thread-delete-file-${uuid(21)}-txt`;
      const error = yield* Effect.flip(service.deleteFile({ fileId: unknownId }));
      expect(error.message).toBe(`Personal file '${unknownId}' was not found.`);
    }).pipe(Effect.provide(testLayer)),
);
