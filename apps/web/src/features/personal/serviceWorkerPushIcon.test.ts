// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import { botAvatarGeometryJson } from "./botAvatarShapes";

const source = NodeFS.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

const FALLBACK_ICON = "/apple-touch-icon.png";
const BLOB_URL = "blob:https://bots.example/avatar-1";

interface WorkerOptions {
  /**
   * How the geometry fetch behaves. "shell" is what this server actually does
   * for a file it does not have: 200 with the app shell's HTML, not a 404.
   */
  readonly geometry?: "ok" | "404" | "shell" | "offline" | "offline-once" | "hang";
  /** Leave OffscreenCanvas out of the worker's globals. */
  readonly noOffscreenCanvas?: boolean;
  /** Throw while drawing (an old engine without roundRect does this). */
  readonly drawThrows?: boolean;
  /** The platform refuses a notification carrying a blob: icon. */
  readonly refusesBlobIcon?: boolean;
}

function worker(options: WorkerOptions = {}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const geometryBody = botAvatarGeometryJson();
  let fetches = 0;
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe("/bot-avatar-shapes.json");
    fetches += 1;
    if (options.geometry === "offline") throw new Error("Offline");
    if (options.geometry === "offline-once" && fetches === 1) throw new Error("Offline");
    if (options.geometry === "hang") return await new Promise<never>(() => {});
    if (options.geometry === "404") return { ok: false, status: 404, json: async () => ({}) };
    if (options.geometry === "shell") {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(geometryBody) };
  });
  const calls: string[] = [];
  const context2d = {
    scale: (...args: number[]) => calls.push(`scale(${args.join(",")})`),
    translate: (...args: number[]) => calls.push(`translate(${args.join(",")})`),
    rotate: (angle: number) => calls.push(`rotate(${angle.toFixed(4)})`),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    roundRect: (...args: number[]) => {
      if (options.drawThrows) throw new TypeError("context.roundRect is not a function");
      calls.push(`roundRect(${args.join(",")})`);
    },
    fill: (path?: { d: string }) => calls.push(`fill(${path === undefined ? "" : path.d})`),
    stroke: (path?: { d: string }) => calls.push(`stroke(${path === undefined ? "" : path.d})`),
    set fillStyle(value: string) {
      calls.push(`fillStyle=${value}`);
    },
    set strokeStyle(value: string) {
      calls.push(`strokeStyle=${value}`);
    },
    set lineWidth(value: number) {
      calls.push(`lineWidth=${value}`);
    },
    set lineJoin(value: string) {
      calls.push(`lineJoin=${value}`);
    },
  };
  const convertToBlob = vi.fn(async () => ({ type: "image/png" }));
  class OffscreenCanvasStub {
    readonly width: number;
    readonly height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      calls.push(`canvas(${width}x${height})`);
    }
    getContext() {
      return context2d;
    }
    convertToBlob = convertToBlob;
  }
  const showNotification = vi.fn(async (_title: string, notification: { icon?: string }) => {
    if (options.refusesBlobIcon && notification.icon?.startsWith("blob:")) {
      throw new Error("TypeError: failed to fetch the icon");
    }
    return undefined;
  });
  const createObjectURL = vi.fn(() => BLOB_URL);
  const revokeObjectURL = vi.fn();
  class TestURL extends URL {}
  Object.assign(TestURL, { createObjectURL, revokeObjectURL });
  NodeVM.runInNewContext(source, {
    URL: TestURL,
    Response,
    Math,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    TypeError,
    Path2D: class {
      readonly d: string;
      constructor(d: string) {
        this.d = d;
      }
    },
    ...(options.noOffscreenCanvas === true ? {} : { OffscreenCanvas: OffscreenCanvasStub }),
    self: {
      location: new URL("https://bots.example/sw.js?v=test"),
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: { showNotification },
    },
    fetch,
    caches: { match: async () => undefined, open: async () => ({ put: async () => undefined }) },
  });
  return { handlers, showNotification, createObjectURL, revokeObjectURL, fetch, calls };
}

const BOT_PAYLOAD = {
  title: "Planner replied",
  body: "Open the chat to read it.",
  url: "/bots/bot-1/thread-1",
  tag: "chat-thread-1",
  avatarShape: "roundedHexagon",
  avatarColor: "#1A73E8",
};

async function push(app: ReturnType<typeof worker>, data: unknown) {
  let result: Promise<unknown> | undefined;
  app.handlers.get("push")!({
    data: { json: () => data },
    waitUntil: (value: Promise<unknown>) => {
      result = value;
    },
  });
  await result;
}

/**
 * The notification icon is the sending bot's avatar, drawn in the worker.
 * Every one of these cases has to end in a visible banner: the icon is a nicety
 * and the notification is the point.
 *
 * iOS ignores `icon` and always uses the manifest icon, so none of this is
 * observable on an iPhone; it is Android and desktop behaviour.
 */
describe("service worker notification icon", () => {
  it("draws the sending bot's avatar and hands it over as an object URL", async () => {
    const app = worker();
    await push(app, BOT_PAYLOAD);
    expect(app.showNotification).toHaveBeenCalledWith(
      "Planner replied",
      expect.objectContaining({ icon: BLOB_URL, tag: "chat-thread-1" }),
    );
    // The hexagon's own path, from the shared geometry - not a copy.
    expect(app.calls).toContain("fill(M50 8L84.6 28V72L50 92L15.4 72V28Z)");
    expect(app.calls).toContain("fillStyle=#1A73E8");
    // Round corners come from stroking the same path, as in the SVG.
    expect(app.calls).toContain("stroke(M50 8L84.6 28V72L50 92L15.4 72V28Z)");
    expect(app.calls).toContain("lineWidth=7");
    // Two eyes, each drawn tilted about its own centre.
    expect(app.calls.filter((call) => call.startsWith("roundRect("))).toHaveLength(2);
    expect(app.calls).toContain("canvas(192x192)");
  });

  it("revokes the object URL once the notification is up", async () => {
    const app = worker();
    await push(app, BOT_PAYLOAD);
    expect(app.createObjectURL).toHaveBeenCalledOnce();
    expect(app.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
    // Revoked after, never before: the platform must have read the bytes.
    expect(app.revokeObjectURL.mock.invocationCallOrder[0]!).toBeGreaterThan(
      app.showNotification.mock.invocationCallOrder[0]!,
    );
  });

  it("fetches the geometry once across notifications", async () => {
    const app = worker();
    await push(app, BOT_PAYLOAD);
    await push(app, { ...BOT_PAYLOAD, tag: "chat-thread-2" });
    expect(app.fetch).toHaveBeenCalledOnce();
    expect(app.showNotification).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a payload from before the field existed", { title: "Planner finished", url: "/tasks/t-1" }],
    ["a shape the geometry does not know", { ...BOT_PAYLOAD, avatarShape: "dodecahedron" }],
    ["a colour that is not a hex triplet", { ...BOT_PAYLOAD, avatarColor: "javascript:alert(1)" }],
  ])("shows the notification with the app icon for %s", async (_case, payload) => {
    const app = worker();
    await push(app, payload);
    expect(app.showNotification).toHaveBeenCalledWith(
      payload.title,
      expect.objectContaining({ icon: FALLBACK_ICON }),
    );
    expect(app.revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["the geometry is not deployed yet", { geometry: "404" } as const],
    ["the server answers the app shell instead", { geometry: "shell" } as const],
    ["the laptop is unreachable", { geometry: "offline" } as const],
    ["OffscreenCanvas is unavailable", { noOffscreenCanvas: true } as const],
    ["the engine cannot draw a rounded rect", { drawThrows: true } as const],
  ])("falls back to the app icon when %s", async (_case, options) => {
    const app = worker(options);
    await push(app, BOT_PAYLOAD);
    expect(app.showNotification).toHaveBeenCalledOnce();
    expect(app.showNotification).toHaveBeenCalledWith(
      "Planner replied",
      expect.objectContaining({ icon: FALLBACK_ICON, body: BOT_PAYLOAD.body }),
    );
  });

  it("retries with the app icon when the platform refuses the drawn one", async () => {
    const app = worker({ refusesBlobIcon: true });
    await push(app, BOT_PAYLOAD);
    expect(app.showNotification).toHaveBeenCalledTimes(2);
    expect(app.showNotification).toHaveBeenLastCalledWith(
      "Planner replied",
      expect.objectContaining({ icon: FALLBACK_ICON, data: { url: "/bots/bot-1/thread-1" } }),
    );
    expect(app.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
  });

  it("a failed geometry fetch does not cost every later notification its icon", async () => {
    const app = worker({ geometry: "offline-once" });
    await push(app, BOT_PAYLOAD);
    expect(app.showNotification).toHaveBeenLastCalledWith(
      "Planner replied",
      expect.objectContaining({ icon: FALLBACK_ICON }),
    );
    await push(app, { ...BOT_PAYLOAD, tag: "chat-thread-2" });
    expect(app.showNotification).toHaveBeenLastCalledWith(
      "Planner replied",
      expect.objectContaining({ icon: BLOB_URL }),
    );
    expect(app.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not wait forever on a stalled geometry fetch", async () => {
    vi.useFakeTimers();
    try {
      const app = worker({ geometry: "hang" });
      let settled: Promise<unknown> | undefined;
      app.handlers.get("push")!({
        data: { json: () => BOT_PAYLOAD },
        waitUntil: (value: Promise<unknown>) => {
          settled = value;
        },
      });
      await vi.advanceTimersByTimeAsync(3000);
      await settled;
      expect(app.showNotification).toHaveBeenCalledWith(
        "Planner replied",
        expect.objectContaining({ icon: FALLBACK_ICON }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
