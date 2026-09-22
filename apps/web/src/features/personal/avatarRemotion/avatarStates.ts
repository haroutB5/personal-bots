// Explicit `.ts` extensions: `scripts/generate-avatar-keyframes.ts` runs this
// module under plain Node, which does not resolve extensionless specifiers.
import type { AvatarMotion } from "../avatarMotion.ts";
import type { AvatarPose } from "./pose.ts";

export { REST_POSE, type AvatarPose } from "./pose.ts";

/**
 * The bot avatar's motion: the one authored copy.
 *
 * The look follows xAI's Grok Bot widget ("Avatar motion system" on
 * x.ai/news/designing-grok-bot; reverse-read in
 * `personal-bots-notes/remotion-avatars/xai/`). There, every channel is a
 * spring chasing a per-state target that is a function of time, with gaze
 * saccades and blinks fired at random intervals. This module runs the same
 * model offline: a seeded, deterministic spring simulation per state. The
 * Studio and `remotion render` draw it frame by frame, and
 * `avatarKeyframes.ts` samples it into the CSS keyframes the app ships
 * (`avatarMotion.generated.css`). The app never imports this module, and it
 * imports nothing from `remotion`.
 *
 * Their widget draws a ~228-unit head; ours is ~90 units in a 100 viewBox, so
 * body offsets scale by {@link XAI_TO_VIEWBOX}. Our pill eyes are much larger
 * relative to the head, so gaze travel scales by the smaller {@link XAI_GAZE}
 * to keep the eyes on the body. Rotation keeps their degrees times their
 * `tiltScale` ({@link XAI_TILT}).
 *
 * Differences from the widget, all deliberate:
 * - Loops must repeat, so each loop's frequencies are rounded to whole cycles
 *   of its period and its random events are drawn once per period.
 * - Only thinking and working loop in the app (the continuous-motion cap).
 *   Waiting (their `bored`), blocked and done play once and hold.
 * - Their `celebrate` gets its energy from a full-body spin we do not port
 *   (it is a 3D turn of the shape); done uses their `excited` hop cadence
 *   instead, with celebrate's big eyes, and lands on the rest pose.
 * - Their `alerting` (blocked) is a neutral face under a "!" overlay; ours has
 *   no overlay, so blocked borrows their `sad` droop with heavier lids.
 * - Their springs also blend one state into the next. CSS cannot blend one
 *   animation into another, so each state instead opens with the spring
 *   response from rest (the loop's intro).
 */

export const AVATAR_FPS = 30;

/** xAI head units to our viewBox units, for body offsets. */
const XAI_TO_VIEWBOX = 0.39;
/** xAI gaze units to ours: less than the body scale, our eyes are larger. */
const XAI_GAZE = 0.38;
/** xAI's per-shape `tiltScale` for body rotation. */
const XAI_TILT = 0.6;

/** Simulation rate: xAI's substep is 1/120 s too. */
const SIM_HZ = 120;
/** Spring-in from rest before a loop's steady state takes over. */
const INTRO_SECONDS = 1.2;

/** Channels in xAI's units: rotation deg, offsets, y-scale, gaze, lids, eye size. */
interface Channels {
  rot: number;
  x: number;
  y: number;
  sy: number;
  gx: number;
  gy: number;
  lid: number;
  size: number;
  happy: number;
}

type ChannelName = keyof Channels;

const CHANNEL_NAMES: readonly ChannelName[] = [
  "rot",
  "x",
  "y",
  "sy",
  "gx",
  "gy",
  "lid",
  "size",
  "happy",
];

const REST_CHANNELS: Channels = {
  rot: 0,
  x: 0,
  y: 0,
  sy: 1,
  gx: 0,
  gy: 0,
  lid: 1,
  size: 1,
  happy: 0,
};

/** [angular frequency, damping ratio] per channel, as in xAI's `tb(...)` calls. */
const SPRINGS: Record<ChannelName, readonly [number, number]> = {
  rot: [5, 0.9],
  x: [3.5, 1],
  y: [4, 1],
  sy: [10, 0.8],
  gx: [13, 1],
  gy: [13, 1],
  lid: [26, 1],
  size: [9, 0.85],
  happy: [12, 1],
};

/** mulberry32, the PRNG xAI's widget seeds its avatar with. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Saccade {
  readonly at: number;
  readonly gx: number;
  readonly gy: number;
}

interface Blink {
  readonly at: number;
  readonly double: boolean;
}

/** Gaze targets fired every `min..max` seconds across one period. */
function saccades(
  random: () => number,
  period: number,
  [min, max]: readonly [number, number],
  pick: (random: () => number) => readonly [number, number],
): Saccade[] {
  const events: Saccade[] = [];
  for (let at = min * random(); at < period; at += min + (max - min) * random()) {
    const [gx, gy] = pick(random);
    events.push({ at, gx, gy });
  }
  return events;
}

/** Blink start times every `min..max` seconds, clear of the period's wrap. */
function blinks(
  random: () => number,
  period: number,
  [min, max]: readonly [number, number],
): Blink[] {
  const events: Blink[] = [];
  for (let at = 0.6 + min * 0.5 * random(); at < period - 0.7; at += min + (max - min) * random()) {
    events.push({ at, double: random() < 0.14 });
  }
  return events;
}

/**
 * xAI's blink as a lid target: shut (0.05) for 150ms, overshoot open (1.08)
 * until 300ms, then back to the state's own lid; 14% of blinks double up.
 * Returns null outside a blink.
 */
function blinkLid(events: readonly Blink[], t: number): number | null {
  for (const blink of events) {
    const since = t - blink.at;
    if (since < 0 || since >= (blink.double ? 0.48 : 0.3)) continue;
    if (since < 0.15) return 0.05;
    if (since < 0.3) return 1.08;
    if (since < 0.37) return 1;
    return 0.05;
  }
  return null;
}

/** The saccade target in force at phase `t` of a periodic schedule. */
function gazeAt(events: readonly Saccade[], t: number): readonly [number, number] {
  if (events.length === 0) return [0, 0];
  let current = events[events.length - 1]!;
  for (const event of events) {
    if (event.at > t) break;
    current = event;
  }
  return [current.gx, current.gy];
}

const sign = (random: () => number) => (random() < 0.5 ? -1 : 1);
const between = (random: () => number, min: number, max: number) => min + (max - min) * random();
const smoothstep = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

type BodyTargets = Pick<Channels, "rot" | "x" | "y" | "sy">;
type EyeTargets = Pick<Channels, "gx" | "gy" | "lid" | "size" | "happy">;

/**
 * One state's targets. Loops give separate periods for the body and the eyes,
 * so the two layers repeat independently (the working nod is 0.625s, its
 * glances and blinks run on a 10s cycle).
 */
interface StateModel {
  readonly loop: boolean;
  /** One-shot length (loops: unused). */
  readonly seconds: number;
  readonly bodyPeriod: number;
  readonly eyePeriod: number;
  /** Body targets at time `t` (periodic in `bodyPeriod` for loops). */
  readonly body: (t: number) => BodyTargets;
  /**
   * Eye targets at time `t` (periodic in `eyePeriod` for loops), given the
   * current spring values (working widens the eyes as the gaze drops).
   */
  readonly eyes: (t: number, now: Channels) => EyeTargets;
  /** One-shots that must end exactly at rest (done hands over to static idle). */
  readonly endsAtRest?: boolean;
}

function idleModel(): StateModel {
  // idle: d=1.5 sin(.5r)+.6 sin(.17r); o=sin(.27r); A=1.2 sin(.85r); h=1+.007 sin(.85r).
  // Studio/previews only: the app draws idle as the static rest pose.
  const period = 24;
  const w = TAU / period;
  const blinkEvents = blinks(prng(11), 12, [6, 14]);
  return {
    loop: true,
    seconds: 0,
    bodyPeriod: period,
    eyePeriod: 12,
    body: (t) => ({
      rot: 1.5 * Math.sin(2 * w * t) + 0.6 * Math.sin(w * t),
      x: Math.sin(w * t + 1),
      y: 1.2 * Math.sin(3 * w * t),
      sy: 1 + 0.007 * Math.sin(3 * w * t),
    }),
    eyes: (t) => ({ gx: 0, gy: 0, lid: blinkLid(blinkEvents, t) ?? 1, size: 1, happy: 0 }),
  };
}

function thinkingModel(): StateModel {
  // thinking: d=-9+5 sin(.35r); o=5 sin(.3r); A=2.5 sin(.6r); h=1.
  // Saccades every 1.5-2.8s to (+-(.5..1)*15, -(.4..1)*9): up and to a side.
  const bodyPeriod = 21;
  const eyePeriod = 12;
  const w = TAU / bodyPeriod;
  const random = prng(23);
  const gaze = saccades(random, eyePeriod, [1.5, 2.8], (r) => [
    sign(r) * between(r, 0.5, 1) * 15,
    -between(r, 0.4, 1) * 9,
  ]);
  const blinkEvents = blinks(random, eyePeriod, [3.5, 7]);
  return {
    loop: true,
    seconds: 0,
    bodyPeriod,
    eyePeriod,
    body: (t) => ({
      rot: -9 + 5 * Math.sin(w * t),
      x: 5 * Math.sin(w * t + 1.1),
      y: 2.5 * Math.sin(2 * w * t),
      sy: 1,
    }),
    eyes: (t) => {
      const [gx, gy] = gazeAt(gaze, t);
      return { gx, gy, lid: blinkLid(blinkEvents, t) ?? 1, size: 1, happy: 0 };
    },
  };
}

function workingModel(): StateModel {
  // working: t=sin(3.2 pi r); d=4+2.5t; o=3; A=1.5+3 max(0,t); h=1-.02 max(0,t).
  // Saccades every 1.2-2.4s to (15*(-.4..0.4), 9*(.4..1)): down at the work.
  // Blinks every 2.8-5.5s. Eyes grow up to 14% looking down-left.
  const eyePeriod = 10;
  const random = prng(37);
  const gaze = saccades(random, eyePeriod, [1.2, 2.4], (r) => [
    15 * between(r, -0.4, 0.4),
    9 * between(r, 0.4, 1),
  ]);
  const blinkEvents = blinks(random, eyePeriod, [2.8, 5.5]);
  return {
    loop: true,
    seconds: 0,
    bodyPeriod: 1 / 1.6,
    eyePeriod,
    body: (t) => {
      const nod = Math.sin(t * Math.PI * 3.2);
      const up = Math.max(0, nod);
      return { rot: 4 + 2.5 * nod, x: 3, y: 1.5 + 3 * up, sy: 1 - 0.02 * up };
    },
    eyes: (t, now) => {
      const [gx, gy] = gazeAt(gaze, t);
      const size = 1 + 0.14 * smoothstep((-now.gx - 0.5) / 4.5) * smoothstep((now.gy - 3) / 6);
      return { gx, gy, lid: blinkLid(blinkEvents, t) ?? 1, size, happy: 0 };
    },
  };
}

function waitingModel(): StateModel {
  // Their `bored`, settled rather than looped: d=-3; A=5; h=.99; C=.6 (half
  // lids); y=.98; a glance down to one side; one 600ms sigh (h and A swell
  // with sin(pi t)), then hold.
  const random = prng(41);
  const side = sign(random) * between(random, 0.7, 1) * 15;
  const down = 9 * between(random, 0.4, 0.9);
  return {
    loop: false,
    seconds: 2.4,
    bodyPeriod: 0,
    eyePeriod: 0,
    body: (t) => {
      const sigh = t >= 0.7 && t < 1.3 ? Math.sin(((t - 0.7) / 0.6) * Math.PI) : 0;
      return { rot: -3, x: 0, y: 5 + 3 * sigh, sy: 0.99 + 0.05 * sigh };
    },
    eyes: (t) => ({
      gx: t < 0.25 ? 0 : side,
      gy: t < 0.25 ? 0 : down,
      lid: 0.6,
      size: 0.98,
      happy: 0,
    }),
  };
}

function blockedModel(): StateModel {
  // No "!" overlay here, so blocked borrows their `sad` (d=3; A=7; h=.97;
  // y=.97) with heavier lids and the gaze dropped, then holds.
  const random = prng(53);
  const gx = 15 * between(random, -0.3, 0.3);
  const gy = 9 * between(random, 0.6, 1);
  return {
    loop: false,
    seconds: 1.6,
    bodyPeriod: 0,
    eyePeriod: 0,
    body: () => ({ rot: 3, x: 0, y: 7, sy: 0.97 }),
    eyes: () => ({ gx, gy, lid: 0.55, size: 0.97, happy: 0 }),
  };
}

function doneModel(): StateModel {
  // Three hops at their `excited` cadence (2.2/s: A = -10 sin(pi f), squash
  // .92 on take-off, stretch 1.05 rising) with `celebrate`'s big eyes (y=1.1,
  // C=1.1), a happy squint on landing, then rest.
  const hops = 3 / 2.2;
  return {
    loop: false,
    seconds: 2.4,
    bodyPeriod: 0,
    eyePeriod: 0,
    endsAtRest: true,
    body: (t) => {
      if (t >= hops) return { rot: 0, x: 0, y: 0, sy: 1 };
      const f = (2.2 * t) % 1;
      return {
        rot: 0,
        x: 0,
        y: -8 * Math.sin(f * Math.PI),
        sy: f < 0.1 ? 0.92 : f < 0.3 ? 1.05 : 1,
      };
    },
    eyes: (t) => {
      const hopping = t < hops;
      return {
        gx: 0,
        gy: 0,
        lid: hopping ? 1.1 : 1,
        size: hopping ? 1.1 : 1,
        happy: t >= 1.2 && t < 1.7 ? 1 : 0,
      };
    },
  };
}

const MODELS: Record<AvatarMotion, () => StateModel> = {
  idle: idleModel,
  thinking: thinkingModel,
  working: workingModel,
  waiting: waitingModel,
  blocked: blockedModel,
  done: doneModel,
};

/** A simulated state: channel values at SIM_HZ from rest at t = 0. */
interface Simulation {
  readonly model: StateModel;
  readonly samples: Float64Array[];
  readonly steps: number;
  /** Start of the steady-state windows (loops): a whole number of periods in. */
  readonly bodyWindow: number;
  readonly eyeWindow: number;
}

function windowStart(period: number): number {
  // Two seconds of springs is far past settling (slowest: 3.5 rad/s).
  return INTRO_SECONDS + Math.ceil(2 / period) * period;
}

function simulate(state: AvatarMotion): Simulation {
  const model = MODELS[state]();
  const bodyWindow = model.loop ? windowStart(model.bodyPeriod) : 0;
  const eyeWindow = model.loop ? windowStart(model.eyePeriod) : 0;
  const end = model.loop
    ? Math.max(bodyWindow + model.bodyPeriod, eyeWindow + model.eyePeriod)
    : model.seconds;
  const steps = Math.ceil(end * SIM_HZ) + 2;
  const samples = CHANNEL_NAMES.map(() => new Float64Array(steps + 1));
  const now: Channels = { ...REST_CHANNELS };
  const velocity: Channels = {
    rot: 0,
    x: 0,
    y: 0,
    sy: 0,
    gx: 0,
    gy: 0,
    lid: 0,
    size: 0,
    happy: 0,
  };
  const dt = 1 / SIM_HZ;
  const wrap = (t: number, period: number) => (model.loop ? t % period : t);
  for (let step = 0; step <= steps; step += 1) {
    CHANNEL_NAMES.forEach((name, index) => {
      samples[index]![step] = now[name];
    });
    const t = step * dt;
    const targets: Channels = {
      ...model.body(wrap(t, model.bodyPeriod)),
      ...model.eyes(wrap(t, model.eyePeriod), now),
    };
    for (const name of CHANNEL_NAMES) {
      const [omega, zeta] = SPRINGS[name];
      velocity[name] +=
        (-2 * zeta * omega * velocity[name] - omega * omega * (now[name] - targets[name])) * dt;
      now[name] += velocity[name] * dt;
    }
  }
  if (model.endsAtRest) {
    // Ease the last 0.35s onto the exact rest values, so the hand-off to the
    // static avatar cannot jump.
    const fade = Math.round(0.35 * SIM_HZ);
    const last = Math.round(model.seconds * SIM_HZ);
    CHANNEL_NAMES.forEach((name, index) => {
      const series = samples[index]!;
      for (let step = last - fade; step <= steps; step += 1) {
        const k = smoothstep((step - (last - fade)) / fade);
        series[step] = series[step]! + (REST_CHANNELS[name] - series[step]!) * k;
      }
    });
  }
  return { model, samples, steps, bodyWindow, eyeWindow };
}

const simulations = new Map<AvatarMotion, Simulation>();

function simulation(state: AvatarMotion): Simulation {
  let sim = simulations.get(state);
  if (sim === undefined) {
    sim = simulate(state);
    simulations.set(state, sim);
  }
  return sim;
}

function read(sim: Simulation, channel: number, t: number): number {
  const position = Math.min(Math.max(t * SIM_HZ, 0), sim.steps);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sim.steps);
  const series = sim.samples[channel]!;
  return series[lower]! + (series[upper]! - series[lower]!) * (position - lower);
}

const BODY_CHANNELS: ReadonlySet<ChannelName> = new Set(["rot", "x", "y", "sy"]);

function channelsAt(sim: Simulation, t: number): Channels {
  const { model } = sim;
  const out = { ...REST_CHANNELS };
  CHANNEL_NAMES.forEach((name, index) => {
    let time: number;
    if (!model.loop) {
      time = Math.min(Math.max(t, 0), model.seconds);
    } else if (t <= INTRO_SECONDS) {
      time = Math.max(t, 0);
    } else {
      // Past the intro: the steady state, each layer on its own period.
      const body = BODY_CHANNELS.has(name);
      const period = body ? model.bodyPeriod : model.eyePeriod;
      const window = body ? sim.bodyWindow : sim.eyeWindow;
      time = window + ((t - INTRO_SECONDS) % period);
    }
    out[name] = read(sim, index, time);
  });
  return out;
}

function poseFromChannels(c: Channels): AvatarPose {
  return {
    bodyX: c.x * XAI_TO_VIEWBOX,
    bodyY: c.y * XAI_TO_VIEWBOX,
    bodyRotate: c.rot * XAI_TILT,
    bodyScaleX: 1,
    bodyScaleY: c.sy,
    gazeX: c.gx * XAI_GAZE,
    gazeY: c.gy * XAI_GAZE,
    eyeOpen: c.lid * c.size,
    eyeWiden: c.size,
    happy: Math.min(1, Math.max(0, c.happy)),
  };
}

export interface AvatarStateTiming {
  readonly loop: boolean;
  /** Loops: the spring-in from rest before the steady state. */
  readonly introSeconds: number;
  /** Loops: the body layer's period. */
  readonly bodySeconds: number;
  /** Loops: the eye layers' period. */
  readonly eyeSeconds: number;
  /** One-shots: how long until the final pose holds. */
  readonly seconds: number;
}

/** How each state plays over time (the generator and the Studio read it). */
export function avatarStateTiming(state: AvatarMotion): AvatarStateTiming {
  const { model } = simulation(state);
  return {
    loop: model.loop,
    introSeconds: model.loop ? INTRO_SECONDS : 0,
    bodySeconds: model.bodyPeriod,
    eyeSeconds: model.eyePeriod,
    seconds: model.seconds,
  };
}

/**
 * Pose for `state` at `seconds` since it began. Loops run the intro, then the
 * steady state with each layer wrapping on its own period; one-shots clamp,
 * so any time past the end is the held final pose.
 */
export function avatarPoseAtTime(state: AvatarMotion, seconds: number): AvatarPose {
  return poseFromChannels(channelsAt(simulation(state), seconds));
}

export interface AvatarStateSpec {
  readonly durationInFrames: number;
  /** Looping states repeat; the others play once and hold. */
  readonly loop: boolean;
}

const STATES = ["idle", "thinking", "working", "waiting", "blocked", "done"] as const;

/**
 * Studio composition lengths: a loop's intro plus its longest layer period;
 * a one-shot's run.
 */
export const AVATAR_STATE_SPECS = Object.fromEntries(
  STATES.map((state) => {
    const timing = avatarStateTiming(state);
    const seconds = timing.loop
      ? timing.introSeconds + Math.max(timing.bodySeconds, timing.eyeSeconds)
      : timing.seconds;
    return [state, { durationInFrames: Math.ceil(seconds * AVATAR_FPS), loop: timing.loop }];
  }),
) as Record<AvatarMotion, AvatarStateSpec>;

/** Pose for `state` at a 30 fps `frame` (Studio and renders). */
export function avatarPoseAt(state: AvatarMotion, frame: number): AvatarPose {
  return avatarPoseAtTime(state, frame / AVATAR_FPS);
}

/** The pose a one-shot state holds once it has played. */
export function avatarFinalPose(state: AvatarMotion): AvatarPose {
  return avatarPoseAtTime(state, avatarStateTiming(state).seconds);
}
