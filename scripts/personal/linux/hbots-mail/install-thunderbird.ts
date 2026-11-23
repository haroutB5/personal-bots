// Installs the pinned Commonpost add-on into the hbots-mail Thunderbird profile
// and sets Thunderbird to start with the session. It never starts, stops or
// signs in to Thunderbird, and it only writes under the home it is given.
//
//   node scripts/personal/linux/hbots-mail/install-thunderbird.ts --dry-run
//   node scripts/personal/linux/hbots-mail/install-thunderbird.ts [--home <dir>] [--xpi <file>]
//
// Exit codes: 0 done (or a dry run), 1 refused, 2 bad usage.
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import {
  defaultXpiSource,
  installThunderbird,
  type InstallOptions,
} from "../../../../apps/server/src/personal/connections/email/thunderbird/install.ts";

const usage = `Usage: node scripts/personal/linux/hbots-mail/install-thunderbird.ts [--dry-run] [--home <dir>] [--xpi <file>]`;

const parseArgs = (argv: ReadonlyArray<string>): InstallOptions | null => {
  let home = NodeOS.homedir();
  let xpi: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--home" && value !== undefined) {
      home = value;
      index += 1;
    } else if (arg === "--xpi" && value !== undefined) {
      xpi = value;
      index += 1;
    } else return null;
  }
  return { home, xpiSource: xpi ?? defaultXpiSource(home), dryRun };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    console.error(usage);
    process.exit(2);
  }
  const result = installThunderbird(options);
  if (result._tag === "refused") {
    console.error(`refused: ${result.reason}`);
    process.exit(1);
  }
  for (const step of result.steps) {
    console.log(`${options.dryRun ? "would be " : ""}${step.change}: ${step.what} ${step.path}`);
  }
  console.log("Thunderbird reads these at its next start.");
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
