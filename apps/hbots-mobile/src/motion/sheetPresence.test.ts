import { describe, expect, it } from "vite-plus/test";

import { createSheetPresence, type SheetMotionPort } from "./sheetPresence";

function harness() {
  const log: string[] = [];
  let finish: (finished: boolean) => void = () => undefined;
  const port: SheetMotionPort = {
    animateTo: (target, done) => {
      log.push(`animate ${target}`);
      finish = done;
    },
    snapTo: (target) => log.push(`snap ${target}`),
  };
  const presence = createSheetPresence(port, (mounted) => log.push(`mounted ${mounted}`));
  return { presence, log, complete: (finished: boolean) => finish(finished) };
}

describe("createSheetPresence", () => {
  it("mounts, then animates open", () => {
    const { presence, log } = harness();
    presence.show(false);
    expect(log).toEqual(["mounted true", "animate 1"]);
  });

  it("stays mounted through the close motion and unmounts when it finishes", () => {
    const { presence, log, complete } = harness();
    presence.show(false);
    presence.hide(false);
    expect(log.slice(2)).toEqual(["animate 0"]);
    complete(true);
    expect(log.slice(2)).toEqual(["animate 0", "mounted false"]);
  });

  it("does not unmount when a reopen cuts the close short", () => {
    const { presence, log, complete } = harness();
    presence.show(false);
    presence.hide(false);
    const staleClose = complete;
    presence.show(false);
    staleClose(false);
    expect(log.at(-1)).toBe("animate 1");
    expect(log).not.toContain("mounted false");
  });

  it("ignores a close completion that arrives after a reopen", () => {
    const { presence, log, complete } = harness();
    presence.show(false);
    presence.hide(false);
    const staleClose = complete;
    presence.show(false);
    staleClose(true);
    expect(log).not.toContain("mounted false");
  });

  it("goes straight to the final state under reduced motion", () => {
    const { presence, log } = harness();
    presence.show(true);
    expect(log).toEqual(["mounted true", "snap 1"]);
    presence.hide(true);
    expect(log.slice(2)).toEqual(["snap 0", "mounted false"]);
  });

  it("does nothing when hidden before it was ever shown", () => {
    const { presence, log } = harness();
    presence.hide(false);
    expect(log).toEqual([]);
  });

  it("survives a fast open then close then open then close", () => {
    const { presence, log, complete } = harness();
    presence.show(false);
    presence.hide(false);
    presence.show(false);
    presence.hide(false);
    complete(true);
    expect(log.at(-1)).toBe("mounted false");
  });
});
