import { describe, expect, it } from "vite-plus/test";

import { createWindowTouchGate, type WindowTouchNative } from "./windowTouchGate";

function harness() {
  const calls: Array<readonly [number, boolean]> = [];
  const native: WindowTouchNative = {
    setTouchable: (tag, touchable) => calls.push([tag, touchable]),
  };
  return { gate: createWindowTouchGate(native), calls };
}

describe("createWindowTouchGate", () => {
  it("lets touches fall through the window while the sheet closes", () => {
    const { gate, calls } = harness();
    gate.apply(7, false);
    expect(calls).toEqual([[7, false]]);
  });

  it("makes the window touchable again when the sheet reopens mid-close", () => {
    const { gate, calls } = harness();
    gate.apply(7, false);
    gate.apply(7, true);
    expect(calls).toEqual([
      [7, false],
      [7, true],
    ]);
  });

  it("does not repeat a state the window already has", () => {
    const { gate, calls } = harness();
    gate.apply(7, true);
    gate.apply(7, false);
    gate.apply(7, false);
    expect(calls).toEqual([[7, false]]);
  });

  it("treats a new window as touchable and tracks it on its own", () => {
    const { gate, calls } = harness();
    gate.apply(7, false);
    gate.apply(9, true);
    gate.apply(9, false);
    expect(calls).toEqual([
      [7, false],
      [9, false],
    ]);
  });

  it("does nothing without a native module or a view", () => {
    const none = createWindowTouchGate(null);
    expect(() => none.apply(7, false)).not.toThrow();
    const { gate, calls } = harness();
    gate.apply(null, false);
    expect(calls).toEqual([]);
  });
});
