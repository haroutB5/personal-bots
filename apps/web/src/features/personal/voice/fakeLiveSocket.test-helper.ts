/**
 * A fake Gemini Live socket and the harness the voice tests drive a call with.
 * It speaks the same JSON frames the real endpoint does (SpikeTask's findings,
 * 15 Oct 2026), so a test proves the wire without a network.
 */
import type { LiveSocket } from "./liveClient";

export class FakeLiveSocket implements LiveSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeLiveSocket[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Every frame the client sent, parsed. */
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeLiveSocket.instances.push(this);
  }

  /** The real socket opens on the next tick; tests drive it by hand. */
  open(): void {
    this.readyState = FakeLiveSocket.OPEN;
    this.onopen?.({});
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeLiveSocket.CLOSED) return;
    this.readyState = FakeLiveSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** One frame from Gemini, as a string like the real socket delivers. */
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  setupComplete(): void {
    this.receive({ setupComplete: { sessionId: "sess-1" } });
  }

  /** The frames of one kind the client sent. */
  sentOf(kind: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => kind in frame);
  }
}

export function resetFakeSockets(): void {
  FakeLiveSocket.instances = [];
}

export const createFakeSocket = (url: string): LiveSocket => new FakeLiveSocket(url);

/** The last socket the client opened. */
export function latestSocket(): FakeLiveSocket {
  const socket = FakeLiveSocket.instances.at(-1);
  if (socket === undefined) throw new Error("no socket was opened");
  return socket;
}
