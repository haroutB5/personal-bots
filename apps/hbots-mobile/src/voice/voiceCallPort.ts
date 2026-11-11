import { ThreadId } from "@t3tools/contracts";
import {
  voiceCallClientFailureCode,
  voiceFailureDetail,
  type AtomCommandResult,
  type VoiceCallSnapshotResult,
} from "@hbots/personal-client/conversation/voice/voiceCallApi";
import type {
  VoiceApiResult,
  VoiceCallPort,
} from "@hbots/personal-client/voice/voiceCallController";

export type RunVoiceCommand = (
  command: VoiceCommandName,
  input: Readonly<Record<string, unknown>>,
) => Promise<AtomCommandResult<unknown>>;

export type VoiceCommandName =
  | "start"
  | "send"
  | "finish"
  | "lookupMemory"
  | "renewPass"
  | "searchWeb"
  | "snapshot";

function toResult<T>(result: AtomCommandResult<unknown>): VoiceApiResult<T> {
  if (result._tag === "Success") return { ok: true, value: result.value as T };
  return {
    ok: false,
    code: voiceCallClientFailureCode(result),
    detail: voiceFailureDetail(result),
  };
}

const withThread = (input: { readonly threadId: string }) => ({
  ...input,
  threadId: ThreadId.make(input.threadId),
});

export function createVoiceCallPort(run: RunVoiceCommand): {
  readonly api: VoiceCallPort;
  readonly fetchSnapshot: (input: {
    readonly threadId: string;
    readonly callId: string;
  }) => Promise<VoiceApiResult<VoiceCallSnapshotResult>>;
} {
  return {
    api: {
      start: async (threadId) => toResult(await run("start", withThread({ threadId }))),
      send: async (input) => toResult(await run("send", withThread(input))),
      finish: async (input) => {
        const result = await run("finish", withThread(input));
        return result._tag === "Success" ? { ok: true, value: { ok: true } } : toResult(result);
      },
      lookupMemory: async (input) => toResult(await run("lookupMemory", withThread(input))),
      renewPass: async (input) => toResult(await run("renewPass", withThread(input))),
      searchWeb: async (input) => toResult(await run("searchWeb", withThread(input))),
    },
    fetchSnapshot: async (input) => toResult(await run("snapshot", withThread(input))),
  };
}
