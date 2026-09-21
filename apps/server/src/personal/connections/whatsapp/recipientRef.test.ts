import { describe, expect, it } from "@effect/vitest";

import { isRecipientRef, mintRecipientRef, readRecipientRef } from "./recipientRef.ts";
import type { WhatsAppChat } from "./recipients.ts";

const MUM: WhatsAppChat = {
  chatId: "447700900001@c.us",
  displayName: "Mum",
  phoneNumber: "+447700900001",
  isGroup: false,
  unread: false,
  lastMessagePreview: null,
};

describe("whatsapp recipient references", () => {
  it("carries the destination the approval card has to show", () => {
    const read = readRecipientRef(mintRecipientRef(MUM));
    expect(read).toEqual({
      chatId: "447700900001@c.us",
      displayName: "Mum",
      phoneNumber: "+447700900001",
      isGroup: false,
    });
  });

  it("refuses anything a model could have typed instead", () => {
    for (const invented of [
      "+447700900999",
      "Mum",
      "wa1.eyJjaGF0SWQiOiJ4In0.nope",
      "",
      "wa1..",
      mintRecipientRef(MUM).toUpperCase(),
    ]) {
      expect(readRecipientRef(invented), invented).toBeNull();
      expect(isRecipientRef(invented), invented).toBe(false);
    }
  });

  it("refuses a reference whose destination was edited", () => {
    const ref = mintRecipientRef(MUM);
    const [prefix, payload, signature] = ref.split(".") as [string, string, string];
    const swapped = Buffer.from(
      JSON.stringify({
        chatId: "447700900999@c.us",
        displayName: "Mum",
        phoneNumber: "+447700900999",
        isGroup: false,
      }),
      "utf8",
    ).toString("base64url");
    // The attack this exists to stop: keep the signature, change the number.
    expect(readRecipientRef(`${prefix}.${swapped}.${signature}`)).toBeNull();
    expect(readRecipientRef(`${prefix}.${payload}.${signature}`)).not.toBeNull();
  });
});
