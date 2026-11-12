/**
 * Motion values both clients share. The web app keeps them as CSS in
 * `personal.css`; hbots-mobile reads them from here. `motionTokens.test.ts`
 * in apps/web fails when a web duration or bezier stops matching.
 * Durations are milliseconds. Easings are cubic-bezier control points.
 */
export const motionDuration = {
  press: 80,
  stepFade: 120,
  chipIn: 160,
  chipHoldDelay: 150,
  chipHold: 350,
  chipHeld: 120,
  rise: 180,
  banner: 180,
  bannerSnap: 150,
  sheet: 200,
  swipeSettle: 220,
  callIn: 280,
  callRing: 1400,
  callCard: 200,
  replyHighlight: 1600,
  pulse: 2000,
  chevron: 150,
} as const;

export type MotionEase = readonly [number, number, number, number];

export const motionEase = {
  out: [0.2, 0.8, 0.2, 1],
  push: [0.32, 0.72, 0, 1],
  in: [0.4, 0, 1, 1],
  inOut: [0.4, 0, 0.2, 1],
  cssEaseOut: [0, 0, 0.58, 1],
  pulse: [0.4, 0, 0.6, 1],
} as const satisfies Record<string, MotionEase>;

export const motionRise = { translateY: 8 } as const;

export const motionSheet = { translateY: 32 } as const;

export const motionPress = { chip: 0.96, chipHold: 0.92, chipHeld: 1.04 } as const;

export const motionPulse = { low: 0.5 } as const;

export const motionRing = { scale: 1.05, opacityLow: 0.45, opacityHigh: 0.9 } as const;
