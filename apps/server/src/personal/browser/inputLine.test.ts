import { describe, expect, it } from "@effect/vitest";

import { InputLine, MAX_MERGED_WHEEL_DISTANCE, MAX_MERGED_WHEELS } from "./inputLine.ts";

const wheel = (deltaY: number, x = 10, y = 20, deltaX = 0) =>
  `{"_tag":"Wheel","x":${x},"y":${y},"deltaX":${deltaX},"deltaY":${deltaY}}`;
const tap = '{"_tag":"Pointer","action":"tap","x":5,"y":5}';
const key = '{"_tag":"Key","key":"a"}';

const drain = (line: InputLine) => {
  const out: Array<{ raw: string; arrivedAt: number }> = [];
  for (let next = line.take(); next !== undefined; next = line.take()) out.push(next);
  return out;
};
const parsed = (raw: string) => JSON.parse(raw) as Record<string, unknown>;

describe("input line", () => {
  it("merges wheels waiting in a row: deltas summed, the latest point kept", () => {
    const line = new InputLine({ coalesceWheels: true });
    expect(line.push(wheel(10, 1, 1), 100)).toBe(false);
    expect(line.push(wheel(20, 2, 2), 110)).toBe(true);
    expect(line.push(wheel(-5, 3, 3, 7), 120)).toBe(true);
    expect(line.size).toBe(1);
    const [only] = drain(line);
    expect(parsed(only!.raw)).toEqual({ _tag: "Wheel", x: 3, y: 3, deltaX: 7, deltaY: 25 });
    // The oldest arrival is kept, so the wait in line is not understated.
    expect(only!.arrivedAt).toBe(100);
  });

  it("never merges across a tap, a key or any other input, and keeps the order", () => {
    const line = new InputLine({ coalesceWheels: true });
    for (const raw of [
      wheel(1),
      wheel(2),
      tap,
      wheel(3),
      key,
      wheel(4),
      wheel(5),
      '{"_tag":"Back"}',
      wheel(6),
    ]) {
      line.push(raw, 0);
    }
    expect(drain(line).map((entry) => parsed(entry.raw))).toEqual([
      { _tag: "Wheel", x: 10, y: 20, deltaX: 0, deltaY: 3 },
      { _tag: "Pointer", action: "tap", x: 5, y: 5 },
      { _tag: "Wheel", x: 10, y: 20, deltaX: 0, deltaY: 3 },
      { _tag: "Key", key: "a" },
      { _tag: "Wheel", x: 10, y: 20, deltaX: 0, deltaY: 9 },
      { _tag: "Back" },
      { _tag: "Wheel", x: 10, y: 20, deltaX: 0, deltaY: 6 },
    ]);
  });

  it("leaves a wheel the worker already took alone: the next one starts a new entry", () => {
    const line = new InputLine({ coalesceWheels: true });
    line.push(wheel(10), 0);
    const taken = line.take();
    expect(parsed(taken!.raw).deltaY).toBe(10);
    expect(line.push(wheel(20), 1)).toBe(false);
    expect(line.size).toBe(1);
  });

  it("sends a single wheel exactly as it came", () => {
    const line = new InputLine({ coalesceWheels: true });
    const raw = wheel(12, 3, 4);
    line.push(raw, 0);
    expect(line.take()!.raw).toBe(raw);
  });

  it("bounds one merged wheel by count", () => {
    const line = new InputLine({ coalesceWheels: true });
    for (let i = 0; i < MAX_MERGED_WHEELS * 2 + 1; i += 1) line.push(wheel(1), 0);
    const entries = drain(line).map((entry) => parsed(entry.raw).deltaY);
    expect(entries).toEqual([MAX_MERGED_WHEELS, MAX_MERGED_WHEELS, 1]);
  });

  it("bounds one merged wheel by distance, so a stall is not one huge jump", () => {
    const line = new InputLine({ coalesceWheels: true });
    const step = MAX_MERGED_WHEEL_DISTANCE / 3 + 1;
    for (let i = 0; i < 7; i += 1) line.push(wheel(step), 0);
    const entries = drain(line).map((entry) => Math.abs(Number(parsed(entry.raw).deltaY)));
    expect(entries.every((distance) => distance <= MAX_MERGED_WHEEL_DISTANCE)).toBe(true);
    expect(entries.reduce((sum, distance) => sum + distance, 0)).toBeCloseTo(step * 7);
    expect(entries.length).toBeGreaterThan(1);
  });

  it("does not merge a wheel it cannot read", () => {
    const line = new InputLine({ coalesceWheels: true });
    line.push(wheel(1), 0);
    expect(line.push('{"_tag":"Wheel","x":"left"}', 0)).toBe(false);
    expect(line.push(wheel(2), 0)).toBe(false);
    expect(line.size).toBe(3);
  });

  it("queues every wheel as it comes with the kill switch", () => {
    const line = new InputLine({ coalesceWheels: false });
    const raws = [wheel(1), wheel(2), wheel(3)];
    for (const raw of raws) expect(line.push(raw, 0)).toBe(false);
    expect(drain(line).map((entry) => entry.raw)).toEqual(raws);
  });
});
