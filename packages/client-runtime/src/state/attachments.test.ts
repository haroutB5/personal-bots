import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";
import {
  formatAttachmentSize,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as AtomRegistry.AtomRegistry;

type CreateUploadUrlCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;

type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function makeCreateUploadUrl(attachmentId: string): CreateUploadUrlCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success<AttachmentCreateUploadUrlResult, never>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: async (_registry, input) => {
    removeCalls.push(input.input.attachmentId);
    return AsyncResult.success(undefined);
  },
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it("deletes the fresh mint when the caller cancels at onMinted", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });

    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removeCalls).toEqual(["pending-cancelled"]);
  });

  it("keeps the minted id on transfer failure so the caller can retry or release", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-failed"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => ({
        done: Promise.reject(new Error("Upload rejected (413)")),
        abort: () => {},
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-failed",
    });
    expect(removeCalls).toEqual([]);
  });

  it("waits for an asynchronous url resolution before transferring", async () => {
    const transferred: string[] = [];
    let publish: ((url: string) => void) | null = null;
    const pending = runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-async"),
      remove,
      environmentId,
      upload: uploadInput,
      // The web client resolves this against the prepared connection, which it
      // may still be waiting for when the mint returns.
      resolveUploadUrl: () =>
        new Promise<string | null>((resolve) => {
          publish = resolve;
        }),
      transport: (url) => {
        transferred.push(url);
        return { done: Promise.resolve(), abort: () => {} };
      },
    });

    // Drains the microtasks the mint takes, so the outstanding work below is
    // the url resolution and nothing else.
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
    expect(publish).not.toBeNull();
    // The mint has landed and the resolution is outstanding: nothing may move
    // bytes until it answers.
    expect(transferred).toEqual([]);

    publish!("https://environment.test/api/attachments/upload/pending-async");

    expect(await pending).toEqual({ status: "uploaded", attachmentId: "pending-async" });
    expect(transferred).toEqual(["https://environment.test/api/attachments/upload/pending-async"]);
  });

  it("fails at resolve-url when an asynchronous resolution answers null", async () => {
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-unresolved"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => Promise.resolve(null),
      transport: () => {
        throw new Error("transport must not run without a url");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "resolve-url",
      attachmentId: "pending-unresolved",
    });
  });
});

describe("verifyPersistedAttachmentUpload", () => {
  it("hits the server on every verification instead of reusing a cached failure", async () => {
    let lookups = 0;
    const assetUrlAtom = Atom.make(
      Effect.promise(() => Promise.resolve()).pipe(
        Effect.flatMap(() => {
          lookups += 1;
          return lookups === 1
            ? Effect.fail({ _tag: "TransportError" } as const)
            : Effect.succeed({ url: "/api/assets/pending-1" });
        }),
      ),
    ).pipe(Atom.swr({ staleTime: 60_000 }), Atom.keepAlive);
    const liveRegistry = AtomRegistry.make();

    const verify = () =>
      verifyPersistedAttachmentUpload({
        registry: liveRegistry,
        createAssetUrl: () => assetUrlAtom,
        environmentId,
        attachmentId: "pending-1",
      });

    const first = await verify();
    expect(first).toMatchObject({ status: "failed" });

    const second = await verify();
    expect(second).toEqual({ status: "verified" });
    expect(lookups).toBe(2);
  });
});

describe("formatAttachmentSize", () => {
  it.each([
    [1_047_552, "1023 KB"],
    [1_047_553, "1.0 MB"],
    [1_048_575, "1.0 MB"],
    [1_048_576, "1.0 MB"],
  ])("formats %d bytes as %s", (sizeBytes, label) => {
    expect(formatAttachmentSize(sizeBytes)).toBe(label);
  });
});
