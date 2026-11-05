import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    reset: async () => true,
    isOnline: () => true,
    canReachNetwork: async () => true,
  }),
}));

import { failedAttachmentOutcome, UploadRefusedError } from "./outboxNative";

function transferFailure(error: unknown) {
  return {
    status: "failed" as const,
    step: "transfer" as const,
    attachmentId: "att-1",
    error,
  };
}

describe("a failed attachment upload", () => {
  it("a transfer that fails at the network while the socket stays connected is interrupted, not refused", () => {
    expect(
      failedAttachmentOutcome(transferFailure(new Error("Network request failed")), true),
    ).toEqual({ kind: "interrupted" });
  });

  it("only a 4xx or 5xx answer from the upload endpoint is refused", () => {
    expect(failedAttachmentOutcome(transferFailure(new UploadRefusedError(500)), true).kind).toBe(
      "rejected",
    );
  });

  it("a failed URL resolve is interrupted, because the bytes never reached the server", () => {
    expect(
      failedAttachmentOutcome(
        {
          status: "failed",
          step: "resolve-url",
          attachmentId: "att-1",
          error: new Error("The environment is not connected."),
        },
        true,
      ),
    ).toEqual({ kind: "interrupted" });
  });
});
