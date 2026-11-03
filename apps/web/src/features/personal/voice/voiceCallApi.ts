import { createVoiceCallApi } from "@hbots/personal-client/conversation/voice/voiceCallApi";

import { connectionAtomRuntime } from "../../../connection/runtime";

export * from "@hbots/personal-client/conversation/voice/voiceCallApi";

export const {
  personalVoiceCallStart,
  personalVoiceCallsList,
  personalVoiceCallTranscript,
  personalVoiceCallSample,
  personalVoiceCallSnapshot,
  personalVoiceCallSend,
  personalVoiceCallFinish,
  personalVoiceCallCheckKey,
  personalVoiceCallLookupMemory,
  personalVoiceCallRenewPass,
  personalVoiceCallSearchWeb,
} = createVoiceCallApi(connectionAtomRuntime);
