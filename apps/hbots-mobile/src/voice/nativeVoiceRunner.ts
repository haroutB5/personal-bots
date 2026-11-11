import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";

import type { NativePersonal } from "../personal/nativePersonalClient";
import type { RunVoiceCommand, VoiceCommandName } from "./voiceCallPort";

const OPTIONS = { reportFailure: false, reportDefect: false } as const;

export function createVoiceRunner(
  native: NativePersonal,
  registry: AtomRegistry.AtomRegistry,
): RunVoiceCommand {
  const commands = {
    start: native.voice.personalVoiceCallStart,
    send: native.voice.personalVoiceCallSend,
    finish: native.voice.personalVoiceCallFinish,
    lookupMemory: native.voice.personalVoiceCallLookupMemory,
    renewPass: native.voice.personalVoiceCallRenewPass,
    searchWeb: native.voice.personalVoiceCallSearchWeb,
    snapshot: native.voice.personalVoiceCallSnapshot,
  } as const satisfies Record<VoiceCommandName, unknown>;

  return (name, input) => {
    const command = commands[name] as Parameters<typeof runAtomCommand>[1];
    return runAtomCommand(
      registry,
      command,
      { environmentId: native.environmentId, input } as never,
      OPTIONS,
    ) as ReturnType<RunVoiceCommand>;
  };
}
