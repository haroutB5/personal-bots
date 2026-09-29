// Explicit `.ts` extensions: `scripts/generate-avatar-keyframes.ts` runs this
// module under plain Node, which does not resolve extensionless specifiers.
import {
  AVATAR_COMET_FADE_SECONDS,
  AVATAR_COMET_HUE_SECONDS,
  AVATAR_COMETS,
  avatarCometConicGradient,
  avatarCometFrameBox,
  avatarCometRingMask,
} from "../avatarComet.ts";
import { AVATAR_MOTIONS, type AvatarMotion } from "../avatarMotion.ts";
import {
  BOT_AVATAR_EYE_TILT_DEG,
  BOT_AVATAR_ROUND_CORNER_STROKE,
  BOT_AVATAR_SILHOUETTES,
} from "../botAvatarShapes.ts";
import { AVATAR_FPS, avatarPoseAtTime, avatarStateTiming } from "./avatarStates.ts";
import { AVATAR_BODY_PIVOT_X, AVATAR_BODY_PIVOT_Y, REST_POSE, type AvatarPose } from "./pose.ts";

/**
 * Turns the authored motion (`avatarStates.ts`, `avatarComet.ts`) into the
 * CSS the app ships.
 *
 * Each state is sampled at the composition's 30 fps and split into three
 * layers, one per element `BotAvatar` draws when it has a `motion`. They are
 * all HTML boxes (an animation on an SVG child runs on the main thread and
 * repaints the avatar every frame; on a box it runs on the compositor), so
 * every value is `transform` or `opacity`, and viewBox units are percentages
 * of the 100-unit avatar box:
 *
 * - body  (the `.bot-avatar` box itself, plus the `.bot-avatar-body` box
 *   inside it for a loop's steady state): translate, rotate and squash
 *   about the head centre;
 * - pill  (`.bot-avatar-pill`, one per eye): the gaze translate, the eye's
 *   tilt (fixed) and its size/lid scale about its own centre, and its fade
 *   into the happy arc. One animation per eye instead of a gaze layer over
 *   the pair: every animation costs the main thread a little per frame;
 * - arc   (`.bot-avatar-arc`): the happy "^" squint's opacity.
 *
 * A loop plays its spring-in from rest once (`<name>-in`), then its steady
 * state forever, the body and the eyes each on their own period. One-shots
 * play once and hold their last frame. Keyframes a straight line through
 * their neighbours already reproduces (within a hair of a viewBox unit) are
 * dropped, so the timing is `linear` and the file stays small without
 * changing what is drawn. `idle` is the static rest pose in the app and gets
 * no animation at all.
 *
 * The working comet gets its own rules (`avatarComet.ts`, "Compositor
 * renderer"): a fade-in, and per comet its static pieces plus one spin and one
 * hue cycle on the conic gradient that holds it.
 */

interface AvatarLayer {
  readonly name: string;
  readonly selector: string;
  readonly period: "body" | "eyes";
  readonly channels: (pose: AvatarPose) => readonly number[];
  /** Largest error a dropped keyframe may introduce, per channel. */
  readonly tolerance: readonly number[];
  readonly declarations: (values: readonly number[]) => readonly string[];
}

const LAYERS: readonly AvatarLayer[] = [
  {
    name: "body",
    // The avatar box itself; its 100 units are percentages of it.
    selector: "",
    period: "body",
    channels: (p) => [p.bodyX, p.bodyY, p.bodyRotate, p.bodyScaleX, p.bodyScaleY],
    tolerance: [0.04, 0.04, 0.08, 0.002, 0.002],
    declarations: ([x, y, r, sx, sy]) => [
      `transform: translate(${pct(x!)}, ${pct(y!)}) rotate(${num(r!)}deg) scale(${num(sx!)}, ${num(sy!)});`,
    ],
  },
  {
    name: "pill",
    selector: ".bot-avatar-pill",
    period: "eyes",
    channels: (p) => [p.gazeX, p.gazeY, p.eyeWiden, p.eyeOpen, 1 - p.happy],
    tolerance: [0.04, 0.04, 0.005, 0.015, 0.015],
    declarations: ([gx, gy, widen, open, opacity]) => [
      `transform: translate(${pct(gx!)}, ${pct(gy!)}) rotate(${BOT_AVATAR_EYE_TILT_DEG}deg) scale(${num(widen!)}, ${num(open!)});`,
      `opacity: ${num(opacity!)};`,
    ],
  },
  {
    name: "arc",
    selector: ".bot-avatar-arc",
    period: "eyes",
    channels: (p) => [p.happy],
    tolerance: [0.015],
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

function pct(value: number): string {
  const text = num(value);
  return text === "0" ? "0" : `${text}%`;
}

function seconds(value: number): string {
  return `${num(value)}s`;
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

/**
 * Flatten the near-still stretches (a spring's long tail, a held gaze) into
 * exact holds: an unchanged animated value lets the browser skip repainting
 * the avatar, a value creeping by a thousandth does not.
 */
function holdStill(
  samples: readonly (readonly number[])[],
  tolerance: readonly number[],
): (readonly number[])[] {
  const out: (readonly number[])[] = [];
  for (const [index, sample] of samples.entries()) {
    const previous = out[out.length - 1];
    // The ends stay exact: a one-shot's held final pose (done lands on rest)
    // and a loop's seam.
    const still =
      index < samples.length - 1 &&
      previous !== undefined &&
      sample.every(
        (value, channel) => Math.abs(value - previous[channel]!) <= tolerance[channel]! / 4,
      );
    out.push(still ? previous : sample);
  }
  return out;
}

function differsFromRest(
  samples: readonly (readonly number[])[],
  rest: readonly number[],
): boolean {
  return samples.some((sample) =>
    sample.some((value, channel) => Math.abs(value - rest[channel]!) > 1e-6),
  );
}

/** Samples of `layer` over `[from, from + span]`, about 30 per second. */
function sampleLayer(
  state: AvatarMotion,
  layer: AvatarLayer,
  from: number,
  span: number,
): (readonly number[])[] {
  const count = Math.max(8, Math.round(span * AVATAR_FPS));
  return Array.from({ length: count + 1 }, (_, index) =>
    layer.channels(avatarPoseAtTime(state, from + (span * index) / count)),
  );
}

function keyframesBlock(
  name: string,
  layer: AvatarLayer,
  samples: readonly (readonly number[])[],
): string {
  const held = holdStill(samples, layer.tolerance);
  const steps = simplify(held, layer.tolerance).map((index) => {
    const percent = num((index / (held.length - 1)) * 100);
    return `  ${percent}% {\n    ${layer.declarations(held[index]!).join("\n    ")}\n  }`;
  });
  return `@keyframes ${name} {\n${steps.join("\n")}\n}`;
}

function poseCss(): { rules: string[]; keyframes: string[] } {
  const rules: string[] = [];
  const keyframes: string[] = [];
  for (const state of AVATAR_MOTIONS) {
    if (state === "idle") continue;
    const timing = avatarStateTiming(state);
    for (const layer of LAYERS) {
      const rest = layer.channels(REST_POSE);
      const name = avatarKeyframesName(state, layer.name);
      const selector = `.bot-avatar[data-motion="${state}"]${layer.selector ? ` ${layer.selector}` : ""}`;
      if (!timing.loop) {
        const samples = sampleLayer(state, layer, 0, timing.seconds);
        if (!differsFromRest(samples, rest)) continue;
        rules.push(
          `${selector} {\n  animation: ${name} ${seconds(timing.seconds)} linear 1 both;\n}`,
        );
        keyframes.push(keyframesBlock(name, layer, samples));
        continue;
      }
      const period = layer.period === "body" ? timing.bodySeconds : timing.eyeSeconds;
      const intro = sampleLayer(state, layer, 0, timing.introSeconds);
      const steady = sampleLayer(state, layer, timing.introSeconds, period);
      if (!differsFromRest([...intro, ...steady], rest)) continue;
      if (layer.name === "body") {
        // The spring-in and the loop are two animations of the same
        // properties; on one element Chrome refuses to composite either
        // ("target has incompatible animations") and runs both on the main
        // thread for good, committing every layer every frame. So the loop
        // lives on the box inside (`.bot-avatar-body`), the spring-in on the
        // avatar box: one animation each.
        rules.push(
          `${selector} {\n  animation: ${name}-in ${seconds(timing.introSeconds)} linear 1;\n}`,
          `${selector} .bot-avatar-body {\n` +
            `  animation: ${name} ${seconds(period)} linear ${seconds(timing.introSeconds)} infinite;\n}`,
        );
        keyframes.push(keyframesBlock(`${name}-in`, layer, intro));
        keyframes.push(keyframesBlock(name, layer, steady));
        continue;
      }
      rules.push(
        `${selector} {\n` +
          `  animation:\n` +
          `    ${name}-in ${seconds(timing.introSeconds)} linear 1,\n` +
          `    ${name} ${seconds(period)} linear ${seconds(timing.introSeconds)} infinite;\n}`,
      );
      keyframes.push(keyframesBlock(`${name}-in`, layer, intro));
      keyframes.push(keyframesBlock(name, layer, steady));
    }
  }
  return { rules, keyframes };
}

function cometCss(): string[] {
  const css: string[] = [
    // Both comets share one hue cycle (the same phase), so it turns the whole
    // orbit box; the fade-in only fills backwards, so it retires when done.
    ".bot-avatar-orbit {\n" +
      "  position: absolute;\n  inset: 0;\n" +
      "  animation:\n" +
      `    bot-avatar-comet-in ${seconds(AVATAR_COMET_FADE_SECONDS)} ease-out 1 backwards,\n` +
      `    bot-avatar-comet-hue ${seconds(AVATAR_COMET_HUE_SECONDS)} linear infinite;\n}`,
    ".bot-avatar-ring {\n" +
      "  position: absolute;\n  inset: 0;\n" +
      "  -webkit-mask-size: 100% 100%;\n  mask-size: 100% 100%;\n" +
      "  -webkit-mask-repeat: no-repeat;\n  mask-repeat: no-repeat;\n}",
    ".bot-avatar-frame {\n  position: absolute;\n  transform-origin: 50% 50%;\n}",
    ".bot-avatar-conic {\n  position: absolute;\n  inset: 0;\n  will-change: transform;\n}",
  ];
  AVATAR_COMETS.forEach((spec, index) => {
    const box = avatarCometFrameBox(spec);
    // A negative delay starts each comet part-way round its orbit.
    const delay = -((spec.startDeg / 360) * spec.orbitSeconds);
    // The ring mask knocks out the orbit where it passes behind the body, and
    // that depends on the silhouette: one mask per shape.
    for (const [shape, silhouette] of Object.entries(BOT_AVATAR_SILHOUETTES)) {
      const mask = avatarCometRingMask(spec, {
        ...silhouette,
        cornerStroke: BOT_AVATAR_ROUND_CORNER_STROKE,
      });
      css.push(
        `.bot-avatar-ring-${shape}-${index} {\n  -webkit-mask-image: ${mask};\n  mask-image: ${mask};\n}`,
      );
    }
    css.push(
      `.bot-avatar-frame-${index} {\n` +
        `  left: ${num(50 - box / 2)}%;\n  top: ${num(50 - box / 2)}%;\n` +
        `  width: ${num(box)}%;\n  height: ${num(box)}%;\n` +
        `  transform: rotate(${num(spec.rollDeg)}deg) scale(1, ${num(spec.squash)});\n}`,
    );
    css.push(
      `.bot-avatar-conic-${index} {\n` +
        `  background: ${avatarCometConicGradient(spec)};\n` +
        `  animation: bot-avatar-comet-orbit ${seconds(spec.orbitSeconds)} linear ${seconds(delay)} infinite;\n}`,
    );
  });
  css.push("@keyframes bot-avatar-comet-in {\n  0% {\n    opacity: 0;\n  }\n}");
  css.push("@keyframes bot-avatar-comet-orbit {\n  100% {\n    transform: rotate(360deg);\n  }\n}");
  css.push("@keyframes bot-avatar-comet-hue {\n  100% {\n    filter: hue-rotate(360deg);\n  }\n}");
  return css;
}

/** The whole generated stylesheet (`avatarMotion.generated.css`). */
export function avatarMotionCss(): string {
  const { rules, keyframes } = poseCss();
  const header = [
    "/* GENERATED by apps/web/scripts/generate-avatar-keyframes.ts from",
    " * src/features/personal/avatarRemotion/avatarStates.ts and avatarComet.ts.",
    " * Do not edit by hand: change the motion, then run",
    " *   node apps/web/scripts/generate-avatar-keyframes.ts",
    " * (avatarKeyframes.test.ts fails while this file is stale).",
    " *",
    " * The guardrails (hidden-tab pause, reduced motion) live in personal.css.",
    " *",
    " * The body moves the avatar box (pivot: the head centre); each eye's pill",
    " * scales about its own centre, tilted by its own transform. */",
  ].join("\n");
  const origins = [
    `.bot-avatar[data-motion] {\n  transform-origin: ${AVATAR_BODY_PIVOT_X}% ${AVATAR_BODY_PIVOT_Y}%;\n}`,
    `.bot-avatar-pill {\n  transform: rotate(${BOT_AVATAR_EYE_TILT_DEG}deg);\n}`,
    `.bot-avatar-arc {\n  position: absolute;\n  inset: 0;\n  overflow: visible;\n  transform: rotate(${BOT_AVATAR_EYE_TILT_DEG}deg);\n}`,
  ];
  return `${[header, ...origins, ...rules, ...cometCss(), ...keyframes].join("\n\n")}\n`;
}
