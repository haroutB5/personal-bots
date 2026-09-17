// @effect-diagnostics-next-line nodeBuiltinImport:off - locates this repo's own source tree for static analysis.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { BOT_INSTRUCTION_DRIVER_KINDS } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { scanDriverInstructionCoverage } from "./botInstructionCoverage.ts";

const providerDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../provider",
);

const coverage = scanDriverInstructionCoverage(providerDirectory);
const sorted = (kinds: ReadonlyArray<string>): ReadonlyArray<string> => [...kinds].sort();

describe("bot instruction coverage", () => {
  // The scan is the oracle for every other assertion here; if it silently
  // stopped resolving adapters, the rest would pass vacuously.
  it("resolves an adapter for every built-in driver", () => {
    const scannedKinds = new Set(coverage.map((entry) => entry.driverKind));
    for (const driver of BUILT_IN_DRIVERS) {
      const entry = coverage.find((candidate) => candidate.driverKind === driver.driverKind);
      assert.isDefined(
        entry,
        `Driver '${driver.driverKind}' was not found by the source scan. A new driver must declare its kind as ProviderDriverKind.make("<kind>") in provider/Drivers/<Name>Driver.ts and import its adapter from ../Layers/<Name>Adapter.ts, so bot-instruction coverage can be derived rather than guessed.`,
      );
      assert.isNotEmpty(
        entry!.adapterFiles,
        `Driver '${driver.driverKind}' (${entry!.driverFile}) imports no *Adapter.ts module, so whether a personal bot on it receives its persona cannot be determined.`,
      );
    }
    assert.isTrue(scannedKinds.size >= BUILT_IN_DRIVERS.length);
  });

  // The whole point: the list the UI and seeding read is the list the
  // adapters actually implement. Fails in both directions — a driver added
  // to the contracts list without wiring, and an adapter that loses its
  // withBotInstructions call.
  it("matches BOT_INSTRUCTION_DRIVER_KINDS to the adapters that call withBotInstructions", () => {
    const derived = coverage
      .filter((entry) => entry.carriesBotInstructions)
      .map((entry) => entry.driverKind);
    assert.deepEqual(
      sorted(derived),
      sorted(BOT_INSTRUCTION_DRIVER_KINDS),
      `BOT_INSTRUCTION_DRIVER_KINDS (contracts/personalBots.ts) disagrees with the adapter sources. Covered in code: ${JSON.stringify(
        coverage.map((entry) => ({
          driver: entry.driverKind,
          carries: entry.carriesBotInstructions,
          callSite: entry.callSite,
        })),
      )}`,
    );
  });

  // Pins where the persona is actually attached, so a move shows up as a
  // deliberate edit here rather than as a silently different scan result.
  // Codex's call site is two modules below its adapter, which is why the
  // scan follows imports instead of reading the adapter file alone.
  it("names the call site for each covered driver", () => {
    const callSites = Object.fromEntries(
      coverage
        .filter((entry) => entry.carriesBotInstructions)
        .map((entry) => [entry.driverKind, entry.callSite]),
    );
    assert.deepEqual(callSites, {
      claudeAgent: "Layers/ClaudeAdapter.ts",
      codex: "CodexDeveloperInstructions.ts",
      opencode: "Layers/OpenCodeAdapter.ts",
    });
  });

  // Regression pin for the v1.19.0 defect: the three ACP adapters append
  // only buildRuntimeInstructions, never the bot's persona. If one of them
  // is wired up later, this fails and the contracts list must be updated
  // with it (which the assertion above then re-derives).
  it("still reports the ACP providers as not carrying instructions", () => {
    for (const kind of ["cursor", "grok", "antigravity"]) {
      const entry = coverage.find((candidate) => candidate.driverKind === kind);
      if (entry === undefined) continue;
      assert.isFalse(
        entry.carriesBotInstructions,
        `'${kind}' now carries bot instructions — add it to BOT_INSTRUCTION_DRIVER_KINDS.`,
      );
    }
  });
});
