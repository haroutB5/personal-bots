import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    reset: async () => true,
    isOnline: () => true,
    canReachNetwork: async () => true,
  }),
}));

import { classifyUploadAnswer, failedAttachmentOutcome, UploadRefusedError } from "./outboxNative";

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

describe("an upload's HTTP answer", () => {
  it("is a refusal only when the upload route's marker came with it", () => {
    expect(classifyUploadAnswer(500, true)).toBe("refused");
    expect(classifyUploadAnswer(413, true)).toBe("refused");
  });

  it("a gateway 502 or 503 without the marker never reached the endpoint", () => {
    expect(classifyUploadAnswer(502, false)).toBe("unreached");
    expect(classifyUploadAnswer(503, false)).toBe("unreached");
    expect(classifyUploadAnswer(524, false)).toBe("unreached");
  });

  it("an unmarked 404 is a path that does not exist, not the endpoint saying no", () => {
    expect(classifyUploadAnswer(404, false)).toBe("unreached");
  });

  it("2xx is uploaded", () => {
    expect(classifyUploadAnswer(204, true)).toBe("uploaded");
    expect(classifyUploadAnswer(200, false)).toBe("uploaded");
  });
});
