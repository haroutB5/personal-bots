// @effect-diagnostics globalTimers:off - settle delays inside promise-based actions.
/**
 * What each desktop tool does, in terms of helper commands. Runs inside
 * `PersonalDesktop.act`, so the PC is already held when these start.
 */
import {
  captureRegion,
  DesktopCoordinateError,
  type DesktopMonitor,
  makeFrame,
  type ScreenFrame,
  toImage,
  toPhysical,
  toPhysicalRect,
  fitImageSize,
} from "./desktopGeometry.ts";
import { DesktopKeyError, parseKeyCombos } from "./desktopKeys.ts";
import { DesktopHelperError } from "./DesktopHelper.ts";
import type { DesktopActionContext } from "./PersonalDesktop.ts";
import { STOPPED_REASON, PersonalDesktopActionError } from "./PersonalDesktop.ts";

export const DEFAULT_SETTLE_MS = 250;
export const MAX_SETTLE_MS = 5_000;
/** Keeps one typing call well inside the MCP client's 60 s tool timeout. */
export const MAX_TYPE_CHARS = 2_000;

export interface DesktopShot {
  readonly note?: string;
  readonly screenshot?: {
    readonly mimeType: string;
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly image?: {
    readonly width: number;
    readonly height: number;
    readonly monitor: number | "all";
    readonly physicalPixelsPerImagePixel: number;
  };
  readonly cursor?: { readonly x: number; readonly y: number } | null;
  readonly monitors?: ReadonlyArray<{
    readonly index: number;
    readonly primary: boolean;
    readonly width: number;
    readonly height: number;
    readonly scalePercent: number;
  }>;
}

export interface AfterAction {
  readonly screenshot?: boolean | undefined;
  readonly settleMs?: number | undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value));

async function readScreens(
  context: DesktopActionContext,
): Promise<{ monitors: DesktopMonitor[]; locked: boolean }> {
  const info = await context.driver.request("info");
  const raw = Array.isArray(info.monitors) ? info.monitors : [];
  const monitors = raw.map((entry: Record<string, unknown>) => ({
    index: num(entry.index),
    primary: entry.primary === true,
    x: num(entry.x),
    y: num(entry.y),
    width: num(entry.width),
    height: num(entry.height),
    dpi: num(entry.dpi) || 96,
    name: String(entry.name ?? ""),
  }));
  return { monitors, locked: info.locked === true };
}

function requireFrame(context: DesktopActionContext): ScreenFrame {
  if (context.frame === null) {
    throw new DesktopCoordinateError(
      "Take a computer_screenshot first: coordinates are pixels in your latest screenshot.",
    );
  }
  return context.frame;
}

/** Captures a monitor (default: the one the last screenshot showed, else the primary). */
export async function captureShot(
  context: DesktopActionContext,
  monitor?: number | "all",
): Promise<DesktopShot> {
  const { monitors, locked } = await readScreens(context);
  const target = captureRegion(monitors, monitor ?? context.frame?.monitor);
  const frame = makeFrame(target.region, target.monitor);
  const shot = await context.driver.request("screenshot", {
    ...frame.region,
    outWidth: frame.imageWidth,
    outHeight: frame.imageHeight,
    format: "auto",
    quality: 80,
  });
  const cursor = await context.driver.request("cursor");
  context.setFrame(frame);
  return {
    ...(locked
      ? {
          note: "The PC is locked (or a secure Windows prompt is showing): clicks and typing are refused until the user unlocks it. Never try to unlock it yourself.",
        }
      : {}),
    screenshot: {
      mimeType: String(shot.mimeType ?? "image/png"),
      data: String(shot.data),
      width: frame.imageWidth,
      height: frame.imageHeight,
    },
    image: {
      width: frame.imageWidth,
      height: frame.imageHeight,
      monitor: frame.monitor,
      physicalPixelsPerImagePixel:
        Math.round((frame.region.width / frame.imageWidth) * 1000) / 1000,
    },
    cursor: toImage(frame, { x: num(cursor.x), y: num(cursor.y) }),
    monitors: monitors.map((entry) => ({
      index: entry.index,
      primary: entry.primary,
      width: entry.width,
      height: entry.height,
      scalePercent: Math.round((entry.dpi / 96) * 100),
    })),
  };
}

/** A sharper crop of the latest screenshot. The click frame is left as it was. */
export async function zoomShot(
  context: DesktopActionContext,
  rect: { x: number; y: number; width: number; height: number },
): Promise<DesktopShot> {
  const frame = requireFrame(context);
  const region = toPhysicalRect(frame, rect);
  const size = fitImageSize(region.width, region.height);
  const shot = await context.driver.request("screenshot", {
    ...region,
    outWidth: size.width,
    outHeight: size.height,
    format: "auto",
    quality: 85,
  });
  return {
    note: "Zoomed view only: keep using coordinates from your latest computer_screenshot.",
    screenshot: {
      mimeType: String(shot.mimeType ?? "image/png"),
      data: String(shot.data),
      width: size.width,
      height: size.height,
    },
  };
}

/** Waits for the screen to settle and screenshots it, unless the caller opted out. */
async function afterAction(
  context: DesktopActionContext,
  after: AfterAction,
): Promise<DesktopShot> {
  if (after.screenshot === false) return { note: "Done." };
  const settle = Math.max(0, Math.min(MAX_SETTLE_MS, after.settleMs ?? DEFAULT_SETTLE_MS));
  if (settle > 0) await sleep(settle);
  // The user may have hit stop while the screen settled: then the PC is
  // theirs again, and a screenshot of it is no longer this bot's to take.
  if (!context.stillHeld()) {
    throw new PersonalDesktopActionError({ kind: "stopped", reason: STOPPED_REASON });
  }
  return captureShot(context);
}

function modifierKeys(modifiers: string | undefined): number[] {
  if (modifiers === undefined || modifiers.trim().length === 0) return [];
  const combos = parseKeyCombos(modifiers.trim().replace(/\s+/g, "+"));
  const keys = combos.flat();
  if (keys.some((key) => typeof key !== "number")) {
    throw new DesktopKeyError("Modifiers must be named keys such as ctrl, shift, alt or win.");
  }
  return keys as number[];
}

export async function click(
  context: DesktopActionContext,
  input: AfterAction & {
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | undefined;
    clicks?: number | undefined;
    modifiers?: string | undefined;
  },
): Promise<DesktopShot> {
  const point = toPhysical(requireFrame(context), input);
  await context.driver.request("click", {
    ...point,
    button: input.button ?? "left",
    count: Math.max(1, Math.min(3, input.clicks ?? 1)),
    modifiers: modifierKeys(input.modifiers),
  });
  return afterAction(context, input);
}

export async function move(
  context: DesktopActionContext,
  input: AfterAction & { x: number; y: number },
): Promise<DesktopShot> {
  const point = toPhysical(requireFrame(context), input);
  await context.driver.request("move", { x: point.x, y: point.y });
  return afterAction(context, input);
}

export async function drag(
  context: DesktopActionContext,
  input: AfterAction & {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    button?: "left" | "right" | "middle" | undefined;
  },
): Promise<DesktopShot> {
  const frame = requireFrame(context);
  const from = toPhysical(frame, { x: input.fromX, y: input.fromY });
  const to = toPhysical(frame, { x: input.toX, y: input.toY });
  await context.driver.request("drag", {
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    button: input.button ?? "left",
  });
  return afterAction(context, input);
}

export async function scroll(
  context: DesktopActionContext,
  input: AfterAction & {
    x?: number | undefined;
    y?: number | undefined;
    direction: "up" | "down" | "left" | "right";
    amount?: number | undefined;
  },
): Promise<DesktopShot> {
  const amount = Math.max(1, Math.min(30, input.amount ?? 3));
  let point: { x: number; y: number } | null = null;
  if (input.x !== undefined || input.y !== undefined) {
    if (input.x === undefined || input.y === undefined) {
      throw new DesktopCoordinateError("Give both x and y, or neither.");
    }
    point = toPhysical(requireFrame(context), { x: input.x, y: input.y });
  }
  await context.driver.request("scroll", {
    ...point,
    dy: input.direction === "down" ? amount : input.direction === "up" ? -amount : 0,
    dx: input.direction === "right" ? amount : input.direction === "left" ? -amount : 0,
  });
  return afterAction(context, input);
}

export async function typeText(
  context: DesktopActionContext,
  input: AfterAction & { text: string },
): Promise<DesktopShot> {
  if (input.text.length === 0) throw new DesktopKeyError("Nothing to type.");
  if (input.text.length > MAX_TYPE_CHARS) {
    throw new DesktopKeyError(
      `That is ${input.text.length} characters; type at most ${MAX_TYPE_CHARS} per call.`,
    );
  }
  await context.driver.request(
    "type",
    { text: input.text },
    Math.min(55_000, 10_000 + input.text.length * 20),
  );
  return afterAction(context, input);
}

export async function pressKeys(
  context: DesktopActionContext,
  input: AfterAction & { keys: string; repeat?: number | undefined },
): Promise<DesktopShot> {
  const combos = parseKeyCombos(input.keys);
  const repeat = Math.max(1, Math.min(50, input.repeat ?? 1));
  await context.driver.request(
    "keys",
    { combos, repeat },
    Math.min(55_000, 10_000 + repeat * combos.length * 200),
  );
  return afterAction(context, input);
}

export async function cursorPosition(
  context: DesktopActionContext,
): Promise<{ x: number | null; y: number | null; note: string }> {
  const cursor = await context.driver.request("cursor");
  if (context.frame === null) {
    return {
      x: null,
      y: null,
      note: "Take a computer_screenshot first to get coordinates in its pixels.",
    };
  }
  const point = toImage(context.frame, { x: num(cursor.x), y: num(cursor.y) });
  return point === null
    ? { x: null, y: null, note: "The pointer is outside your latest screenshot (another monitor)." }
    : { ...point, note: "In your latest screenshot's pixels." };
}

export { DesktopHelperError };
