import { Text } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { TranscriptRows } from "./CallCardView";
import { tokens } from "../shell/tokens";

export function CallTranscript({
  native,
  callId,
  startedAtMs,
  voiceName,
}: {
  readonly native: NativePersonal;
  readonly callId: string;
  readonly startedAtMs: number;
  readonly voiceName: string | null;
}) {
  const query = native.client.useEnvironmentQuery(
    native.voice.personalVoiceCallTranscript({
      environmentId: native.environmentId,
      input: { callId },
    }),
  );
  const rows = query.data?.transcript;
  if (rows === undefined) {
    return (
      <Text style={{ color: tokens.textTertiary, fontSize: 13 }}>Loading the transcript…</Text>
    );
  }
  if (rows.length === 0) {
    return (
      <Text style={{ color: tokens.textTertiary, fontSize: 13 }}>
        Nothing was written down on this call.
      </Text>
    );
  }
  return <TranscriptRows rows={rows} startedAtMs={startedAtMs} voiceName={voiceName} />;
}
