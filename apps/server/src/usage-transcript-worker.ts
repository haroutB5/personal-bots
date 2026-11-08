// @effect-diagnostics nodeBuiltinImport:off - isolated transcript reader entry.
import * as NodeWorkerThreads from "node:worker_threads";

import { deepSeekUsageFormat } from "@t3tools/provider-deepseek/server/usage";

import {
  readTranscriptRecordsInline,
  type TranscriptParsePosition,
} from "./usage/usageTranscriptReader.ts";

NodeWorkerThreads.parentPort!.on(
  "message",
  async (request: {
    readonly filePath: string;
    readonly resumeFrom?: TranscriptParsePosition;
    readonly options?: { readonly streamingThresholdBytes?: number };
  }) => {
    const result = await readTranscriptRecordsInline(
      request.filePath,
      deepSeekUsageFormat,
      request.resumeFrom,
      request.options,
    );
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port takes no target origin
    NodeWorkerThreads.parentPort!.postMessage(result);
  },
);
