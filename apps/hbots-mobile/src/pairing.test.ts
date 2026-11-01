import { describe, expect, it } from "vite-plus/test";

import { decodeTicket } from "./pairing";

describe("decodeTicket", () => {
  it("accepts the ticket response the server sends, expiresAt included as an ISO string", () => {
    const wire = JSON.parse(
      '{"ticket":"abc123","expiresAt":"2026-11-01T16:40:00.000Z"}',
    ) as unknown;
    expect(decodeTicket(wire).ticket).toBe("abc123");
  });

  it("rejects an empty ticket", () => {
    expect(() => decodeTicket({ ticket: "  ", expiresAt: "2026-11-01T16:40:00.000Z" })).toThrow();
  });
});
