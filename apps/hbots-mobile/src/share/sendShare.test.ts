import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const outbox = vi.hoisted(() => ({
  enqueueOutboxEntry: vi.fn(),
  putOutboxBlobs: vi.fn(async () => undefined),
  deleteOutboxBlobs: vi.fn(async () => undefined),
}));

vi.mock("@hbots/personal-client/composer/outbox", () => ({
  enqueueOutboxEntry: outbox.enqueueOutboxEntry,
  newOutboxId: () => "msg-1",
  outboxCommandId: (id: string) => `cmd-${id}`,
}));
vi.mock("@hbots/personal-client/composer/outboxBlobs", () => ({
  putOutboxBlobs: outbox.putOutboxBlobs,
  deleteOutboxBlobs: outbox.deleteOutboxBlobs,
}));
vi.mock("@hbots/personal-client/feed/composerText", () => ({
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT: "See the attached files.",
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_PROVIDER_INTERACTION_MODE: "default",
  DEFAULT_RUNTIME_MODE: "full-access",
  botEffectiveModelSelection: () => ({ provider: "p", model: "m" }),
}));

import type { PersonalBot } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { SHARE_MAX_BYTES, type PickerIntent, type PickerState } from "./pickerModel";
import { queueShare, sendShare } from "./sendShare";

const native = { environmentId: "env-1" } as unknown as NativePersonal;
const bot = { botId: "bot-1", name: "Atlas", enabled: true } as unknown as PersonalBot;
const photo = {
  kind: "image" as const,
  uri: "file:///cache/a.jpg",
  name: "a.jpg",
  mime: "image/jpeg",
  bytes: 1000,
};

function confirm(intent: PickerIntent, botId = "bot-1", note = ""): PickerState {
  return { step: "confirm", intent, botId, target: "new", note };
}
const textIntent: PickerIntent = { kind: "share", items: [{ kind: "text", text: "hello" }] };
const started = vi.fn(async () => ({ kind: "started" as const, threadId: "thread-1" }));

beforeEach(() => {
  outbox.enqueueOutboxEntry.mockReset().mockReturnValue({ id: "msg-1" });
  outbox.putOutboxBlobs.mockClear();
  outbox.deleteOutboxBlobs.mockClear();
  started.mockClear();
});

describe("sendShare", () => {
  it("starts a chat, queues the message in the outbox and reports sent", async () => {
    const next = await sendShare({
      state: confirm(textIntent, "bot-1", "look"),
      bots: [bot],
      native,
      start: started,
    });
    expect(next).toEqual({ step: "sent", botId: "bot-1", threadId: "thread-1" });
    expect(outbox.enqueueOutboxEntry).toHaveBeenCalledTimes(1);
    const entry = outbox.enqueueOutboxEntry.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      id: "msg-1",
      threadId: "thread-1",
      environmentId: "env-1",
      text: "look\n\nhello",
    });
  });

  it("refuses an attachment over the cap and queues nothing", async () => {
    const big = { ...photo, bytes: SHARE_MAX_BYTES + 1 };
    const state = confirm({ kind: "share", items: [big] });
    const next = await sendShare({ state, bots: [bot], native, start: started });
    expect(next).toMatchObject({
      step: "confirm",
      error: "That file is over 25 MB. Share a smaller one.",
    });
    expect(started).not.toHaveBeenCalled();
    expect(outbox.putOutboxBlobs).not.toHaveBeenCalled();
    expect(outbox.enqueueOutboxEntry).not.toHaveBeenCalled();
  });

  it("queues an attachment through the outbox blobs and entry, the offline path", async () => {
    const next = await sendShare({
      state: confirm({ kind: "share", items: [photo] }),
      bots: [bot],
      native,
      start: started,
    });
    expect(next.step).toBe("sent");
    expect(outbox.putOutboxBlobs).toHaveBeenCalledWith("msg-1", [
      {
        id: "msg-1-0",
        blob: { uri: photo.uri, size: 1000, mimeType: "image/jpeg", name: "a.jpg" },
      },
    ]);
    const entry = outbox.enqueueOutboxEntry.mock.calls[0]?.[0];
    expect(entry.sendText).toBe("See the attached files.");
    expect(entry.attachments).toEqual([
      { id: "msg-1-0", kind: "image", name: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 },
    ]);
  });

  it("returns to confirm and drops the saved files when the outbox refuses the entry", async () => {
    outbox.enqueueOutboxEntry.mockReturnValue(null);
    const next = await sendShare({
      state: confirm({ kind: "share", items: [photo] }),
      bots: [bot],
      native,
      start: started,
    });
    expect(next).toMatchObject({
      step: "confirm",
      error: "Couldn't save that message on this device.",
    });
    expect(outbox.deleteOutboxBlobs).toHaveBeenCalledWith("msg-1");
  });

  it("returns to confirm when the chat cannot be started", async () => {
    const failing = vi.fn(async () => ({ kind: "failed" as const, message: "offline" }));
    const next = await sendShare({
      state: confirm(textIntent),
      bots: [bot],
      native,
      start: failing,
    });
    expect(next).toMatchObject({ step: "confirm", error: "Couldn't send. Try again." });
    expect(outbox.enqueueOutboxEntry).not.toHaveBeenCalled();
  });

  it("does nothing when no bot is chosen yet", async () => {
    const pick: PickerState = { step: "pick", intent: textIntent, query: "" };
    const next = await sendShare({ state: pick, bots: [bot], native, start: started });
    expect(next).toBe(pick);
    expect(started).not.toHaveBeenCalled();
    expect(outbox.enqueueOutboxEntry).not.toHaveBeenCalled();
  });

  it("returns to confirm when the chosen bot is gone", async () => {
    const next = await sendShare({
      state: confirm(textIntent, "bot-9"),
      bots: [bot],
      native,
      start: started,
    });
    expect(next).toMatchObject({ step: "confirm", error: "That bot isn't available any more." });
    expect(started).not.toHaveBeenCalled();
  });
});

describe("queueShare", () => {
  it("reports a failed file save without enqueueing", async () => {
    outbox.putOutboxBlobs.mockRejectedValueOnce(new Error("disk full"));
    const result = await queueShare({
      native,
      bot,
      threadId: "t",
      message: { text: "", files: [photo] },
    });
    expect(result).toEqual({ ok: false, error: "Couldn't save those files on this device." });
    expect(outbox.enqueueOutboxEntry).not.toHaveBeenCalled();
  });
});
