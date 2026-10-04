import appScopes from "./proposals/proposals-4oct-a-apps.json" with { type: "json" };
import duplicates from "./proposals/proposals-2oct-b-duplicates.json" with { type: "json" };
import devTeam from "./proposals/proposals-2oct-c-dev-team.json" with { type: "json" };
import splits from "./proposals/proposals-2oct-d-splits.json" with { type: "json" };
import finance from "./proposals/proposals-2oct-e-finance.json" with { type: "json" };

import type { ShippedProposalFile } from "./PersonalMemoryTidyService.ts";

/**
 * One-off memory proposals that ship inside the release: at startup each is
 * written into `<baseDir>/personal/memory-proposals/` unless it was already
 * there, imported or rejected, and imported once this version reaches its
 * minVersion. Nothing applies until the owner taps Approve. Keep file names
 * short: the importer redacts long token-like strings, label included.
 */
export const SHIPPED_MEMORY_PROPOSALS: ReadonlyArray<ShippedProposalFile> = [
  { name: "proposals-2oct-b-duplicates.json", file: duplicates },
  { name: "proposals-2oct-c-dev-team.json", file: devTeam },
  { name: "proposals-2oct-d-splits.json", file: splits },
  { name: "proposals-2oct-e-finance.json", file: finance },
  { name: "proposals-4oct-a-apps.json", file: appScopes },
];
