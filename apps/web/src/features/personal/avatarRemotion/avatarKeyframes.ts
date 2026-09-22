// Explicit `.ts` extensions: `scripts/generate-avatar-keyframes.ts` runs this
// module under plain Node, which does not resolve extensionless specifiers.
import { AVATAR_MOTIONS, type AvatarMotion } from "../avatarMotion.ts";
import { AVATAR_FPS, AVATAR_STATE_SPECS, avatarPoseAt } from "./avatarStates.ts";
import { AVATAR_BODY_PIVOT_X, AVATAR_BODY_PIVOT_Y, REST_POSE, type AvatarPose } from "./pose.ts";

/**
 * Turns the authored poses (`avatarStates.ts`) into the CSS the app ships.
 *
 * Each state is sampled at the composition's 30 fps and split into four
 * layers, one per element `BotAvatar` draws when it has a `motion`:
 *
 * - body  (`.bot-avatar-body`): translate, rotate and squash around the bottom
 *   centre, in viewBox units;
 * - gaze  (`.bot-avatar-eyes`): the eye pair's translate;
 * - pill  (`.bot-avatar-pill`): each eye's widen/open scale around its own
 *   centre, and its fade into the happy arc;
 * - arc   (`.bot-avatar-arc`): the happy "^" squint's opacity.
 *
 * Keyframes a straight line through their neighbours already reproduces
 * (within a hair of a viewBox unit) are dropped, so the timing is `linear`
 * and the file stays small without changing what is drawn. `idle` is the
 * static rest pose in the app and gets no animation at all.
 */

interface AvatarLayer {
  readonly name: string;
  readonly selector: string;
  readonly channels: (pose: AvatarPose) => readonly number[];
  /** Largest error a dropped keyframe may introduce, per channel. */
  readonly tolerance: readonly number[];
  readonly declarations: (values: readonly number[]) => readonly string[];
}

const LAYERS: readonly AvatarLayer[] = [
  {
    name: "body",
    selector: ".bot-avatar-body",
    channels: (p) => [p.bodyX, p.bodyY, p.bodyRotate, p.bodyScaleX, p.bodyScaleY],
    tolerance: [0.03, 0.03, 0.05, 0.002, 0.002],
    declarations: ([x, y, r, sx, sy]) => [
      `transform: translate(${px(x!)}, ${px(y!)}) rotate(${num(r!)}deg) scale(${num(sx!)}, ${num(sy!)});`,
    ],
  },
  {
    name: "gaze",
    selector: ".bot-avatar-eyes",
    channels: (p) => [p.gazeX, p.gazeY],
    tolerance: [0.03, 0.03],
    declarations: ([x, y]) => [`transform: translate(${px(x!)}, ${px(y!)});`],
  },
  {
    name: "pill",
    selector: ".bot-avatar-pill",
    channels: (p) => [p.eyeWiden, p.eyeOpen, 1 - p.happy],
    tolerance: [0.004, 0.01, 0.01],
    declarations: ([widen, open, opacity]) => [
      `transform: scale(${num(widen!)}, ${num(open!)});`,
      `opacity: ${num(opacity!)};`,
    ],
  },
  {
    name: "arc",
    selector: ".bot-avatar-arc",
    channels: (p) => [p.happy],
    tolerance: [0.01],
    declarations: ([opacity]) => [`opacity: ${num(opacity!)};`],
  },
];

/** Name of a state's keyframes for one layer (`bot-avatar-done-body`, ...). */
export function avatarKeyframesName(state: AvatarMotion, layer: string): string {
  return `bot-avatar-${state}-${layer}`;
}

function num(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

function px(value: number): string {
  const text = num(value);
  return text === "0" ? "0" : `${text}px`;
}

/** Indices of the samples to keep: the ends, plus every corner a line would miss. */
function simplify(samples: readonly (readonly number[])[], tolerance: readonly number[]): number[] {
  const last = samples.length - 1;
  const kept = [0];
  let anchor = 0;
  for (let end = 2; end <= last; end += 1) {
    const from = samples[anchor]!;
    const to = samples[end]!;
    let fits = true;
    for (let mid = anchor + 1; mid < end && fits; mid += 1) {
      const t = (mid - anchor) / (end - anchor);
      const sample = samples[mid]!;
      fits = sample.every(
        (value, channel) =>
          Math.abs(from[channel]! + (to[channel]! - from[channel]!) * t - value) <=
          tolerance[channel]!,
      );
    }
    if (!fits) {
      kept.push(end - 1);
      anchor = end - 1;
    }
  }
  if (last > 0) kept.push(last);
  return kept;
}

function differsFromRest(
  samples: readonly (readonly number[])[],
  rest: readonly number[],
): boolean {
  return samples.some((sample) =>
    sample.some((value, channel) => Math.abs(value - rest[channel]!) > 1e-6),
  );
}

interface StateTiming {
  /** Frames sampled: a loop includes its wrap frame (equal to frame 0). */
  readonly frames: number;
  readonly seconds: number;
  readonly iteration: string;
}

function timingFor(state: AvatarMotion): StateTiming {
  const { durationInFrames, loop } = AVATAR_STATE_SPECS[state];
  // A loop spans all its frames and wraps to frame 0; a one-shot plays
  // frames 0..n-1 and holds the last one.
  const span = loop ? durationInFrames : durationInFrames - 1;
  return {
    frames: span + 1,
    seconds: span / AVATAR_FPS,
    iteration: loop ? "infinite" : "1 both",
  };
}

/** The whole generated stylesheet (`avatarMotion.generated.css`). */
export function avatarMotionCss(): string {
  const rules: string[] = [];
  const keyframes: string[] = [];
  for (const state of AVATAR_MOTIONS) {
    if (state === "idle") continue;
    const timing = timingFor(state);
    for (const layer of LAYERS) {
      const samples = Array.from({ length: timing.frames }, (_, frame) =>
        layer.channels(avatarPoseAt(state, frame)),
      );
      if (!differsFromRest(samples, layer.channels(REST_POSE))) continue;
      const name = avatarKeyframesName(state, layer.name);
      rules.push(
        `.bot-avatar[data-motion="${state}"] ${layer.selector} {\n` +
          `  animation: ${name} ${num(timing.seconds)}s linear ${timing.iteration};\n}`,
      );
      const steps = simplify(samples, layer.tolerance).map((frame) => {
        const percent = num((frame / (timing.frames - 1)) * 100);
        return `  ${percent}% {\n    ${layer.declarations(samples[frame]!).join("\n    ")}\n  }`;
      });
      keyframes.push(`@keyframes ${name} {\n${steps.join("\n")}\n}`);
    }
  }
  const header = [
    "/* GENERATED by apps/web/scripts/generate-avatar-keyframes.ts from",
    " * src/features/personal/avatarRemotion/avatarStates.ts. Do not edit by hand:",
    " * change the poses, then run",
    " *   node apps/web/scripts/generate-avatar-keyframes.ts",
    " * (avatarKeyframes.test.ts fails while this file is stale).",
    " *",
    " * The guardrails (hidden-tab pause, reduced motion) live in personal.css.",
    " *",
    " * The body pivots on its bottom centre in viewBox units; each eye scales",
    " * about its own centre (its parent <g> carries the eye's tilt). */",
  ].join("\n");
  const origins = [
    `.bot-avatar-body {\n  transform-box: view-box;\n  transform-origin: ${AVATAR_BODY_PIVOT_X}px ${AVATAR_BODY_PIVOT_Y}px;\n}`,
    ".bot-avatar-pill {\n  transform-box: fill-box;\n  transform-origin: center;\n}",
  ];
  return `${[header, ...origins, ...rules, ...keyframes].join("\n\n")}\n`;
}
