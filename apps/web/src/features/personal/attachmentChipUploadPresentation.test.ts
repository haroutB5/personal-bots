import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachmentChipUploadPresentation } from "./attachmentChipUploadPresentation";

const environmentId = EnvironmentId.make("environment-personal-composer");

describe("attachment chip upload presentation", () => {
  it("treats missing and other-environment jobs as pending", () => {
    expect(attachmentChipUploadPresentation(undefined, environmentId)).toEqual({
      status: "pending",
    });
    expect(
      attachmentChipUploadPresentation(
        {
          status: "failed",
          environmentId: EnvironmentId.make("another-environment"),
          reason: "Wrong environment",
        },
        environmentId,
      ),
    ).toEqual({ status: "pending" });
  });

  it("selects uploading, ready, and failed presentation details", () => {
    expect(
      attachmentChipUploadPresentation(
        { status: "uploading", environmentId, progress: 0.429 },
        environmentId,
      ),
    ).toEqual({ status: "uploading", progressLabel: "42%" });
    expect(
      attachmentChipUploadPresentation(
        { status: "ready", environmentId, attachmentId: "attachment-1" },
        environmentId,
      ),
    ).toEqual({ status: "ready" });
    expect(
      attachmentChipUploadPresentation(
        { status: "failed", environmentId, reason: "Connection interrupted" },
        environmentId,
      ),
    ).toEqual({ status: "failed", reason: "Connection interrupted" });
  });
});
