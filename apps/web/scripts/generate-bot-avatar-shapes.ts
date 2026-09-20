/*
 * Writes `apps/web/public/bot-avatar-shapes.json` from the one authored copy of
 * the avatar geometry (`src/features/personal/botAvatarShapes.ts`).
 *
 * The service worker draws the sending bot's avatar into the push notification
 * icon and cannot import from `src/`, so it fetches that JSON at push time.
 * `botAvatarGeometryAsset.test.ts` fails if the checked-in file no longer
 * matches the module, so a retouched shape cannot ship half-applied.
 *
 *   node apps/web/scripts/generate-bot-avatar-shapes.ts
 */
import * as NodeFS from "node:fs";

import { botAvatarGeometryJson } from "../src/features/personal/botAvatarShapes.ts";

const target = new URL("../public/bot-avatar-shapes.json", import.meta.url);
NodeFS.writeFileSync(target, botAvatarGeometryJson(), "utf8");
process.stdout.write(`wrote ${NodeFS.realpathSync(target)}\n`);
