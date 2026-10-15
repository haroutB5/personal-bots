// @effect-diagnostics nodeBuiltinImport:off - isolated transcript reader entry.
import { parentPort } from "node:worker_threads";

import {
  readTranscriptRecordsInline,
  type TranscriptParsePosition,
} from "./usage/usageTranscriptReader.ts";

parentPort!.on(
  "message",
  async (request: {
    readonly filePath: string;
    readonly resumeFrom?: TranscriptParsePosition;
    readonly options?: { readonly streamingThresholdBytes?: number };
  }) => {
    const result = await readTranscriptRecordsInline(
      request.filePath,
      "deepseek",
      request.resumeFrom,
      request.options,
    );
    parentPort!.postMessage(result);
  },
);
