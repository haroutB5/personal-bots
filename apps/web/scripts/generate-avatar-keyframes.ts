/*
 * Writes `apps/web/src/features/personal/avatarMotion.generated.css` from the
 * one authored copy of the avatar's motion
 * (`src/features/personal/avatarRemotion/avatarStates.ts`, the same pose
 * functions the Remotion Studio previews).
 *
 * The app ships the sampled CSS keyframes, never Remotion itself.
 * `avatarKeyframes.test.ts` fails if the checked-in file no longer matches the
 * poses, so a retouched state cannot ship half-applied.
 *
 *   node apps/web/scripts/generate-avatar-keyframes.ts
 */
import * as NodeFS from "node:fs";

import { avatarMotionCss } from "../src/features/personal/avatarRemotion/avatarKeyframes.ts";

const target = new URL("../src/features/personal/avatarMotion.generated.css", import.meta.url);
NodeFS.writeFileSync(target, avatarMotionCss(), "utf8");
process.stdout.write(`wrote ${NodeFS.realpathSync(target)}\n`);
