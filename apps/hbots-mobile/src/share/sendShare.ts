import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  botEffectiveModelSelection,
  type PersonalBot,
} from "@t3tools/contracts";
import {
  enqueueOutboxEntry,
  newOutboxId,
  outboxCommandId,
} from "@hbots/personal-client/composer/outbox";
import { deleteOutboxBlobs, putOutboxBlobs } from "@hbots/personal-client/composer/outboxBlobs";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@hbots/personal-client/feed/composerText";

import type { StartChatResult } from "../chat/useStartChat";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { NEW_CHAT_START_TIMEOUT_MS } from "../screens/newChatStart";
import {
  SHARE_MAX_BYTES,
  buildShareMessage,
  sendFailed,
  sendSucceeded,
  type PickerState,
  type ShareMessage,
} from "./pickerModel";

const MAX_TITLE_SEED = 80;

function titleSeed(message: ShareMessage): string {
  const first = message.files[0];
  const seed =
    message.text.trim().length > 0
      ? message.text.trim()
      : first === undefined
        ? "New chat"
        : `${first.kind === "image" ? "Image" : "File"}: ${first.name}`;
  return seed.slice(0, MAX_TITLE_SEED);
}

/**
 * Puts the message in the outbox for a chat that already exists. The shell's
 * flusher is the only sender, so this survives the app closing and a dropped
 * connection exactly like a message typed in the composer.
 */
export async function queueShare(input: {
  readonly native: NativePersonal;
  readonly bot: PersonalBot;
  readonly threadId: string;
  readonly message: ShareMessage;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const { native, bot, threadId, message } = input;
  const messageId = newOutboxId();
  const attachments = message.files.map((file, index) => ({
    id: `${messageId}-${index}`,
    kind: file.kind,
    name: file.name,
    mimeType: file.mime,
    sizeBytes: file.bytes,
    uri: file.uri,
  }));
  try {
    if (attachments.length > 0) {
      await putOutboxBlobs(
        messageId,
        attachments.map((attachment) => ({
          id: attachment.id,
          blob: {
            uri: attachment.uri,
            size: attachment.sizeBytes,
            mimeType: attachment.mimeType,
            name: attachment.name,
          },
        })),
      );
    }
  } catch {
    return { ok: false, error: "Couldn't save those files on this device." };
  }
  const entry = enqueueOutboxEntry({
    id: messageId,
    commandId: outboxCommandId(messageId),
    kind: "turn",
    environmentId: native.environmentId,
    threadId,
    groupId: null,
    text: message.text,
    sendText: message.text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    createdAt: new Date().toISOString(),
    replyTo: null,
    turn: {
      modelSelection: botEffectiveModelSelection(bot),
      titleSeed: titleSeed(message),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      followUp: null,
    },
    attachments: attachments.map(({ uri: _uri, ...rest }) => rest),
  });
  if (entry === null) {
    void deleteOutboxBlobs(messageId);
    return { ok: false, error: "Couldn't save that message on this device." };
  }
  return { ok: true };
}

function startWithTimeout(start: () => Promise<StartChatResult>): Promise<StartChatResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "interrupted" }), NEW_CHAT_START_TIMEOUT_MS);
    void start().then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/**
 * The picker's send step: a confirm state in, the next state out. Any failure returns to confirm
 * with content intact, and nothing is queued unless every check passed. Every Send asks for the
 * same `threadId`, so a lost reply never makes a second chat. A start silent past the timeout fails.
 */
export async function sendShare(input: {
  readonly state: PickerState;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly native: NativePersonal;
  readonly threadId: string;
  readonly start: (
    botId: string,
    options: { readonly threadId: string },
  ) => Promise<StartChatResult>;
}): Promise<PickerState> {
  const { state, bots, native, start, threadId } = input;
  if (state.step !== "confirm") return state;
  const bot = bots.find((candidate) => candidate.botId === state.botId);
  if (bot === undefined) return sendFailed(state, "That bot isn't available any more.");
  const message = buildShareMessage(state.intent, state.note);
  if (message.files.some((file) => file.bytes > SHARE_MAX_BYTES)) {
    return sendFailed(state, "That file is over 25 MB. Share a smaller one.");
  }
  const started = await startWithTimeout(() => start(bot.botId as string, { threadId }));
  if (started.kind !== "started") return sendFailed(state, "Couldn't send. Try again.");
  const queued = await queueShare({ native, bot, threadId: started.threadId, message });
  if (!queued.ok) return sendFailed(state, queued.error);
  return sendSucceeded(bot.botId as string, started.threadId);
}
