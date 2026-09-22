/**
 * The pose vocabulary of the animated avatar, kept free of any `remotion`
 * import. `AvatarFace` draws it for the Studio; `avatarKeyframes.ts` turns it
 * into the CSS the app ships.
 */
export interface AvatarPose {
  /** Whole-body translate, viewBox units. */
  readonly bodyX: number;
  readonly bodyY: number;
  /** Whole-body rotation in degrees, pivoting on the bottom centre (50, 90). */
  readonly bodyRotate: number;
  /** Squash/stretch around the bottom centre. */
  readonly bodyScaleX: number;
  readonly bodyScaleY: number;
  /** Eye-pair translate (gaze), viewBox units, on top of the body. */
  readonly gazeX: number;
  readonly gazeY: number;
  /** Eye openness: 1 open, ~0.1 closed (vertical scale of each pill). */
  readonly eyeOpen: number;
  /** Horizontal eye scale (widen/narrow). */
  readonly eyeWiden: number;
  /** 0..1 cross-fade from pill eyes to happy "^" arcs. */
  readonly happy: number;
}

/** Body pivot in viewBox units: bottom centre, so squash and tilt read as weight. */
export const AVATAR_BODY_PIVOT_X = 50;
export const AVATAR_BODY_PIVOT_Y = 90;

export const REST_POSE: AvatarPose = {
  bodyX: 0,
  bodyY: 0,
  bodyRotate: 0,
  bodyScaleX: 1,
  bodyScaleY: 1,
  gazeX: 0,
  gazeY: 0,
  eyeOpen: 1,
  eyeWiden: 1,
  happy: 0,
};
