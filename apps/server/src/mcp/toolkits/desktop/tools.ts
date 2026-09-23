import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Every refusal the desktop tools return; `reason` is written for the calling model. */
export class DesktopToolError extends Schema.TaggedError<DesktopToolError>()("DesktopToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const DesktopToolFailure = Schema.Union([McpCapabilityUnavailableError, DesktopToolError]);
export type DesktopToolFailureType = typeof DesktopToolFailure.Type;

const Coordinate = Schema.Number.annotate({
  description: "Pixel in your latest computer_screenshot image (0,0 is its top-left).",
});

const ScreenshotAfter = Schema.optional(
  Schema.Boolean.annotate({
    description:
      "Return a fresh screenshot once the screen settles (default true). Pass false when chaining several quick actions, then call computer_screenshot yourself.",
  }),
);

const SettleMs = Schema.optional(
  Schema.Int.annotate({
    description:
      "How long to wait before that screenshot, in ms (default 250, max 5000). Raise it for slow apps or animations.",
  }),
);

export const DesktopImage = Schema.Struct({
  mimeType: Schema.String,
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});

const MonitorEntry = Schema.Struct({
  index: Schema.Int,
  primary: Schema.Boolean,
  width: Schema.Int,
  height: Schema.Int,
  scalePercent: Schema.Int,
});

/**
 * The screenshot every desktop tool can hand back. `screenshot` is sent to
 * the model as image content, the rest as JSON beside it.
 */
export const DesktopShotResult = Schema.Struct({
  note: Schema.optional(Schema.String),
  screenshot: Schema.optional(DesktopImage),
  image: Schema.optional(
    Schema.Struct({
      width: Schema.Int,
      height: Schema.Int,
      monitor: Schema.Union([Schema.Int, Schema.Literal("all")]),
      physicalPixelsPerImagePixel: Schema.Number,
    }),
  ),
  cursor: Schema.optional(
    Schema.NullOr(Schema.Struct({ x: Schema.Int, y: Schema.Int })).annotate({
      description: "Mouse pointer in screenshot pixels; null when it is on another monitor.",
    }),
  ),
  monitors: Schema.optional(Schema.Array(MonitorEntry)),
});
export type DesktopShotResult = typeof DesktopShotResult.Type;

export const ScreenshotInput = Schema.Struct({
  monitor: Schema.optional(
    Schema.Union([Schema.Int, Schema.Literal("all")]).annotate({
      description:
        'Monitor index from the monitors list (default: the primary monitor), or "all" for every monitor in one image. Later coordinates refer to this image.',
    }),
  ),
});

export const ZoomInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Schema.Number.annotate({ description: "Width of the region, in screenshot pixels." }),
  height: Schema.Number.annotate({ description: "Height of the region, in screenshot pixels." }),
});

export const ClickInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  clicks: Schema.optional(
    Schema.Int.annotate({
      description: "1 (default), 2 for a double click, 3 for a triple click.",
    }),
  ),
  modifiers: Schema.optional(
    Schema.String.annotate({
      description: 'Keys held during the click, joined by "+", e.g. "ctrl" or "ctrl+shift".',
    }),
  ),
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

export const MoveInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

export const DragInput = Schema.Struct({
  fromX: Coordinate,
  fromY: Coordinate,
  toX: Coordinate,
  toY: Coordinate,
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

export const ScrollInput = Schema.Struct({
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.optional(Schema.Int.annotate({ description: "Wheel notches, 1-30 (default 3)." })),
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

export const TypeInput = Schema.Struct({
  text: Schema.String.annotate({
    description:
      "Text typed at the keyboard focus, as a person would type it. \\n presses Enter. At most 5000 characters.",
  }),
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

export const KeyInput = Schema.Struct({
  keys: Schema.String.annotate({
    description:
      'Key combination(s): keys in one combination joined by "+", combinations separated by spaces, pressed in order. Examples: "enter", "ctrl+c", "alt+tab", "win+r", "ctrl+shift+esc", "ctrl+a delete", "alt+f4". Names: ctrl, alt, shift, win, enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1-f24, a-z, 0-9, or a single symbol.',
  }),
  repeat: Schema.optional(Schema.Int.annotate({ description: "Press it this many times (1-50)." })),
  screenshot: ScreenshotAfter,
  settleMs: SettleMs,
});

const NoInput = Schema.Struct({
  reason: Schema.optional(Schema.String.annotate({ description: "Optional note; unused." })),
});

export const CursorResult = Schema.Struct({
  x: Schema.NullOr(Schema.Int),
  y: Schema.NullOr(Schema.Int),
  note: Schema.String,
});

export const ReleaseResult = Schema.Struct({
  released: Schema.Boolean,
  note: Schema.String,
});

const SHARED =
  "It drives the user's real Windows PC (one bot at a time; you may wait in line while another bot has it). Coordinates are pixels in your latest computer_screenshot.";

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description: `See the user's real Windows desktop: returns an image of one monitor (the primary by default), the monitor list, and where the mouse pointer is. Take one before your first action and whenever you need to look again; every later coordinate refers to the latest one. ${SHARED}`,
  parameters: ScreenshotInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot the PC")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerZoomTool = Tool.make("computer_zoom", {
  description:
    "Look closer at part of the desktop: returns a sharper image of a region of your latest screenshot (given in that screenshot's pixels), for reading small text. Coordinates for clicks still refer to the full screenshot, not this image.",
  parameters: ZoomInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Zoom into the PC screen")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerClickTool = Tool.make("computer_click", {
  description: `Move the mouse to a point and click (left by default; right, middle, double or triple click too). Returns a fresh screenshot unless you pass screenshot=false. ${SHARED}`,
  parameters: ClickInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Click on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerMoveTool = Tool.make("computer_move", {
  description: `Move the mouse pointer without clicking, for hover menus and tooltips. ${SHARED}`,
  parameters: MoveInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Move the mouse on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerDragTool = Tool.make("computer_drag", {
  description: `Press the mouse at one point, drag to another and release: moving windows, sliders, selecting text. ${SHARED}`,
  parameters: DragInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Drag on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerScrollTool = Tool.make("computer_scroll", {
  description: `Scroll with the mouse wheel, over a point when given (otherwise wherever the pointer is). ${SHARED}`,
  parameters: ScrollInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Scroll on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerTypeTool = Tool.make("computer_type", {
  description: `Type text into whatever has keyboard focus (click the field first). Never type passwords: the user enters those. ${SHARED}`,
  parameters: TypeInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Type on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerKeyTool = Tool.make("computer_key", {
  description: `Press keys or shortcuts, such as enter, ctrl+s, alt+tab or win+r. ${SHARED}`,
  parameters: KeyInput,
  success: DesktopShotResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Press keys on the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerCursorTool = Tool.make("computer_cursor_position", {
  description: "Where the mouse pointer is, in your latest screenshot's pixels.",
  parameters: NoInput,
  success: CursorResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Mouse position on the PC")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerReleaseTool = Tool.make("computer_release", {
  description:
    "Hand the PC back as soon as you are done with it, so the user's screen shows no bot at the controls and other bots waiting for it can start. It is also freed when your turn ends.",
  parameters: NoInput,
  success: ReleaseResult,
  failure: DesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Release the PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Tools whose results may carry an image; registered by hand so it goes out as image content. */
export const DesktopImageToolkit = Toolkit.make(
  ComputerScreenshotTool,
  ComputerZoomTool,
  ComputerClickTool,
  ComputerMoveTool,
  ComputerDragTool,
  ComputerScrollTool,
  ComputerTypeTool,
  ComputerKeyTool,
);

export const DesktopStandardToolkit = Toolkit.make(ComputerCursorTool, ComputerReleaseTool);

export const DESKTOP_IMAGE_TOOLS = [
  ComputerScreenshotTool,
  ComputerZoomTool,
  ComputerClickTool,
  ComputerMoveTool,
  ComputerDragTool,
  ComputerScrollTool,
  ComputerTypeTool,
  ComputerKeyTool,
] as const;
