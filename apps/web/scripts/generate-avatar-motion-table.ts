/*
 * Writes `packages/personal-client/src/bots/avatarMotionTable.generated.ts` from avatarStates.ts.
 * `avatarMotionTable.test.ts` fails if the checked-in file is stale.
 * Run: node apps/web/scripts/generate-avatar-motion-table.ts
 */
import * as NodeFS from "node:fs";

import { avatarMotionTableSource } from "../src/features/personal/avatarRemotion/avatarMotionTable.ts";

const target = new URL(
  "../../../packages/personal-client/src/bots/avatarMotionTable.generated.ts",
  import.meta.url,
);
NodeFS.writeFileSync(target, avatarMotionTableSource(), "utf8");
process.stdout.write(`wrote ${NodeFS.realpathSync(target)}\n`);
