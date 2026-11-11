import { describe, expect, it } from "vite-plus/test";

import {
  keepsSharedFiles,
  SHARE_MAX_BYTES,
  SHARE_MAX_ITEMS,
  SHARE_MAX_TEXT_CHARS,
  backToPick,
  beginSend,
  blockedMessage,
  buildShareMessage,
  filterBots,
  hasAttachments,
  intakeShare,
  openPicker,
  pickBot,
  previewLabel,
  sendFailed,
  sendSucceeded,
  setNote,
  setQuery,
  setTarget,
  type Intake,
  type PickerIntent,
  type PickerState,
  type RawShare,
  type RawShareItem,
} from "./pickerModel";

const stream = (fields: Partial<Extract<RawShareItem, { kind: "stream" }>> = {}): RawShareItem => ({
  kind: "stream",
  uri: "file:///cache/a.jpg",
  name: "a.jpg",
  mime: "image/jpeg",
  bytes: 1000,
  ...fields,
});
const text = (value: string): RawShareItem => ({ kind: "text", text: value });
const share = (items: ReadonlyArray<RawShareItem>, count = items.length): RawShare => ({
  ask: false,
  count,
  items,
});
const ask = (value: string): RawShare => ({ ask: true, count: 1, items: [text(value)] });
const online = { paired: true, online: true };

const ok = (raw: RawShare): Intake & { readonly ok: true } => {
  const intake = intakeShare(raw);
  if (!intake.ok) throw new Error("expected the share to be accepted");
  return intake;
};
const intentOf = (raw: RawShare): PickerIntent => ok(raw).intent;

describe("the caps", () => {
  it("takes up to the item cap and refuses one more", () => {
    const items = Array.from({ length: SHARE_MAX_ITEMS }, () => stream());
    expect(intakeShare(share(items)).ok).toBe(true);
    expect(intakeShare(share(items, SHARE_MAX_ITEMS + 1))).toEqual({
      ok: false,
      reason: "too-many-items",
    });
  });

  it("takes a file at the size cap and refuses one byte over", () => {
    expect(intakeShare(share([stream({ bytes: SHARE_MAX_BYTES })])).ok).toBe(true);
    expect(intakeShare(share([stream({ bytes: SHARE_MAX_BYTES + 1 })]))).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses a file the share activity did not copy", () => {
    expect(intakeShare(share([stream({ uri: null })]))).toEqual({ ok: false, reason: "too-large" });
  });

  it("takes text at the character cap and refuses one over", () => {
    expect(intakeShare(share([text("a".repeat(SHARE_MAX_TEXT_CHARS))])).ok).toBe(true);
    expect(intakeShare(share([text("a".repeat(SHARE_MAX_TEXT_CHARS + 1))]))).toEqual({
      ok: false,
      reason: "text-too-long",
    });
  });

  it("counts several text pieces against one cap", () => {
    const half = "a".repeat(SHARE_MAX_TEXT_CHARS / 2 + 1);
    expect(intakeShare(share([text(half), text(half)]))).toEqual({
      ok: false,
      reason: "text-too-long",
    });
  });

  it("refuses a selection over the character cap", () => {
    expect(intakeShare(ask("a".repeat(SHARE_MAX_TEXT_CHARS + 1)))).toEqual({
      ok: false,
      reason: "text-too-long",
    });
    expect(intakeShare(ask("a".repeat(SHARE_MAX_TEXT_CHARS))).ok).toBe(true);
  });

  it("refuses a type hbots does not take", () => {
    expect(intakeShare(share([stream({ mime: "video/mp4", name: "v.mp4" })]))).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
  });

  it("takes photos, PDFs and text files", () => {
    const intake = ok(
      share([
        stream(),
        stream({ mime: "application/pdf", name: "a.pdf" }),
        stream({ mime: "text/plain", name: "a.txt" }),
      ]),
    );
    expect(intake.intent.kind === "share" && intake.intent.items.map((i) => i.kind)).toEqual([
      "image",
      "file",
      "file",
    ]);
  });

  it("refuses an empty share and an empty selection", () => {
    expect(intakeShare(share([], 0))).toEqual({ ok: false, reason: "empty" });
    expect(intakeShare(share([text("   ")]))).toEqual({ ok: false, reason: "empty" });
    expect(intakeShare(ask("  "))).toEqual({ ok: false, reason: "empty" });
  });

  it("gives every refusal a sentence", () => {
    for (const reason of [
      "not-paired",
      "offline-attachments",
      "too-large",
      "unsupported-type",
      "too-many-items",
      "text-too-long",
      "empty",
    ] as const) {
      expect(blockedMessage(reason).length).toBeGreaterThan(5);
    }
  });
});

describe("PickerState: pick", () => {
  it("opens on the list for an accepted share", () => {
    const state = openPicker(ok(share([stream()])), online);
    expect(state).toMatchObject({ step: "pick", query: "", intent: { kind: "share" } });
  });

  it("opens an Ask on the list too", () => {
    expect(openPicker(ok(ask("why")), online)).toMatchObject({
      step: "pick",
      intent: { kind: "ask", text: "why" },
    });
  });

  it("keeps the search text", () => {
    const state = setQuery(openPicker(ok(share([text("hi")])), online), "ju");
    expect(state).toMatchObject({ step: "pick", query: "ju" });
  });

  it("filters bots by name", () => {
    const bots = [{ name: "Juno" }, { name: "Forge" }];
    expect(filterBots(bots, " ju ")).toEqual([{ name: "Juno" }]);
    expect(filterBots(bots, "")).toBe(bots);
    expect(filterBots(bots, "xyz")).toEqual([]);
  });
});

describe("PickerState: confirm", () => {
  const picked = (): PickerState => pickBot(openPicker(ok(share([text("hi")])), online), "bot-1");

  it("starts a new chat with an empty note", () => {
    expect(picked()).toMatchObject({ step: "confirm", botId: "bot-1", target: "new", note: "" });
  });

  it("takes a note and a target", () => {
    const state = setTarget(setNote(picked(), "look"), { threadId: "t-1" });
    expect(state).toMatchObject({ note: "look", target: { threadId: "t-1" } });
  });

  it("goes back to the list with the search cleared", () => {
    expect(backToPick(picked())).toMatchObject({ step: "pick", query: "" });
  });

  it("ignores a pick outside the list", () => {
    const confirm = picked();
    expect(pickBot(confirm, "bot-2")).toBe(confirm);
  });
});

describe("PickerState: sending, sent, failure", () => {
  const confirm = (): PickerState =>
    setNote(pickBot(openPicker(ok(share([text("hi")])), online), "bot-1"), "n");

  it("sends only from confirm", () => {
    expect(beginSend(confirm())).toEqual({ step: "sending" });
    const list = openPicker(ok(share([text("hi")])), online);
    expect(beginSend(list)).toBe(list);
    expect(beginSend({ step: "sending" })).toEqual({ step: "sending" });
  });

  it("ends on the sent row", () => {
    expect(sendSucceeded("bot-1", "t-9")).toEqual({
      step: "sent",
      botId: "bot-1",
      threadId: "t-9",
    });
  });

  it("returns to confirm with the note and the error", () => {
    expect(sendFailed(confirm(), "Couldn't send. Try again.")).toMatchObject({
      step: "confirm",
      note: "n",
      botId: "bot-1",
      error: "Couldn't send. Try again.",
    });
  });
});

describe("PickerState: blocked", () => {
  it("blocks an unpaired phone before anything else", () => {
    expect(openPicker(ok(share([text("hi")])), { paired: false, online: true })).toEqual({
      step: "blocked",
      reason: "not-paired",
    });
    expect(openPicker({ ok: false, reason: "empty" }, { paired: false, online: true })).toEqual({
      step: "blocked",
      reason: "not-paired",
    });
  });

  it("blocks attachments offline but not text", () => {
    const offline = { paired: true, online: false };
    expect(openPicker(ok(share([stream()])), offline)).toEqual({
      step: "blocked",
      reason: "offline-attachments",
    });
    expect(openPicker(ok(share([text("hi")])), offline).step).toBe("pick");
  });

  it("carries a cap refusal through", () => {
    expect(openPicker({ ok: false, reason: "too-large" }, online)).toEqual({
      step: "blocked",
      reason: "too-large",
    });
    expect(openPicker({ ok: false, reason: "unsupported-type" }, online)).toEqual({
      step: "blocked",
      reason: "unsupported-type",
    });
  });

  it("does not move on once blocked", () => {
    const blocked: PickerState = { step: "blocked", reason: "empty" };
    expect(setQuery(blocked, "a")).toBe(blocked);
    expect(pickBot(blocked, "b")).toBe(blocked);
    expect(beginSend(blocked)).toBe(blocked);
  });
});

describe("the message", () => {
  it("quotes an Ask under the question", () => {
    const intent = intentOf(ask("line one\nline two"));
    expect(buildShareMessage(intent, "What does this mean?")).toEqual({
      text: "What does this mean?\n\n> line one\n> line two",
      files: [],
    });
  });

  it("sends a bare Ask as the quote alone", () => {
    const intent = intentOf(ask("why"));
    expect(buildShareMessage(intent, "  ").text).toBe("> why");
  });

  it("puts the note before shared text and keeps the files", () => {
    const message = buildShareMessage(intentOf(share([text("see this"), stream()])), "note");
    expect(message.text).toBe("note\n\nsee this");
    expect(message.files.map((file) => file.name)).toEqual(["a.jpg"]);
  });

  it("describes the preview", () => {
    const intent = intentOf(
      share([stream(), stream(), stream({ mime: "application/pdf" }), text("x")]),
    );
    expect(previewLabel(intent)).toBe("2 photos and 1 file and text to send");
    expect(hasAttachments(intent)).toBe(true);
    expect(previewLabel({ kind: "ask", text: "hello" })).toBe("Selected text: hello");
  });
});

describe("when the shared files are still needed", () => {
  const ok = intakeShare({ ask: false, count: 1, items: [{ kind: "text", text: "hello" }] });

  it("keeps them while the user picks, confirms, sends", () => {
    const pick = openPicker(ok, { paired: true, online: true });
    expect(keepsSharedFiles(pick)).toBe(true);
  });

  it.each([
    ["a refusal", openPicker({ ok: false, reason: "too-large" }, { paired: true, online: true })],
    ["an unpaired phone", openPicker(ok, { paired: false, online: true })],
  ])("does not keep them after %s", (_name, state) => {
    expect(state.step).toBe("blocked");
    expect(keepsSharedFiles(state)).toBe(false);
  });
});
