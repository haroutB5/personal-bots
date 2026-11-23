// Tests for select-flows.mjs: which diff puts which emulator flows before the release, the core
// always runs, and every flow lands in exactly one tier.
// Run: node --test apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/select-flows.test.mjs
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  CORE,
  DRIVE_METHODS,
  F10_FILLERS,
  FLOWS,
  driveFlows,
  driveParts,
  flowOrder,
  ruleFor,
  selectFlows,
} from "./select-flows.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const DRIVE = NodeFS.readFileSync(NodePath.join(here, "drive.py"), "utf8");
const SRC = "apps/hbots-mobile/src/";
const SKILL = "apps/hbots-mobile/.claude/skills/verify-hbots-android/";
const notCore = (flows) => flows.filter((flow) => !CORE.includes(flow));

function assertSplit(sel) {
  NodeAssert.deepEqual(
    [...sel.blocking, ...sel.async].sort((a, b) => a - b),
    [...FLOWS].sort((a, b) => a - b),
  );
  NodeAssert.equal(
    sel.blocking.filter((flow) => sel.async.includes(flow)).length,
    0,
    "no flow in both tiers",
  );
  for (const flow of CORE) NodeAssert.ok(sel.blocking.includes(flow), `core flow ${flow} blocks`);
}

NodeTest.test(
  "the core (1 and 8) always runs before the release, every other flow after live",
  () => {
    for (const paths of [
      [],
      ["docs/notes.md"],
      [`${SRC}chat/chatModel.test.ts`],
      ["apps/server/src/provider/Foo.ts"],
    ]) {
      const sel = selectFlows(paths);
      assertSplit(sel);
      NodeAssert.deepEqual(sel.blocking, CORE, paths.join(","));
      NodeAssert.equal(sel.all, false);
    }
  },
);

NodeTest.test("a feature change blocks its own flows plus the core", () => {
  const cases = [
    [
      [`${SRC}chat/cards/SecretRequestCard.tsx`, `${SRC}chat/cards/secretRequestCardModel.ts`],
      [12],
    ],
    [[`${SRC}chat/cards/ToolApprovalCard.tsx`], [10, 11, 13]],
    [["apps/server/src/personal/approvals/approvalTimeoutPolicy.ts"], [10, 11, 13]],
    [[`${SRC}settings/RestartLaptopRow.tsx`], [11]],
    [
      [
        `${SRC}settings/EmailScreen.tsx`,
        "packages/personal-client/src/connections/personalConnections.ts",
      ],
      [13],
    ],
    [["apps/server/src/personal/connections/gateway.ts"], [13]],
    [
      [
        `${SRC}chat/cards/DelegationCard.tsx`,
        "packages/personal-client/src/conversation/delegationModel.ts",
      ],
      [14],
    ],
    [[`${SRC}chat/AttachSheet.tsx`], [3, 2]],
    [[`${SRC}chat/Composer.tsx`], [7, 9, 3, 2]],
    [[`${SRC}chat/MessageList.tsx`], [7, 9]],
    [[`${SRC}tasks/TasksScreen.tsx`], [5, 4]],
    [[`${SRC}notifications/pushController.ts`], [5, 6]],
    [[`${SRC}chat/useChatCards.ts`], [10, 11, 13, 12, 14, 4]],
    [[`${SRC}chat/chatModel.ts`], [7, 9, 3, 2, 10, 11, 13, 12, 14]],
    [[`${SRC}shell/BotsScreen.tsx`], [6, 10, 11, 13, 14]],
    [[`${SRC}settings/MemoryScreen.tsx`], []],
  ];
  for (const [paths, want] of cases) {
    const sel = selectFlows(paths);
    assertSplit(sel);
    NodeAssert.equal(sel.all, false, paths.join(","));
    NodeAssert.deepEqual(new Set(notCore(sel.blocking)), new Set(want), paths.join(","));
  }
});

NodeTest.test("an unsure or shared change runs every flow before the release", () => {
  const cases = [
    "apps/server/src/persistence/Migrations/161_Foo.ts",
    "apps/server/src/persistence/Migrations.ts",
    `${SRC}App.tsx`,
    `${SRC}shell/AppShell.tsx`,
    `${SRC}nav/routes.ts`,
    "apps/hbots-mobile/app.config.ts",
    "apps/hbots-mobile/modules/hbots-camera/android/src/main/java/X.kt",
    "apps/hbots-mobile/scripts/build-android.sh",
    "packages/contracts/src/personalRpc.ts",
    "packages/client-runtime/src/index.ts",
    "packages/personal-client/src/index.ts",
    "pnpm-lock.yaml",
    `${SKILL}scripts/srv.mjs`,
    `${SKILL}scripts/ui.py`,
    `${SKILL}scripts/verify.sh`,
    `${SKILL}scripts/select-flows.mjs`,
    "scripts/personal/testing/fake-claude/cli.js",
    "scripts/personal/linux/hbots-release/lib/gateScope.mjs",
  ];
  for (const file of cases) {
    const sel = selectFlows([file]);
    assertSplit(sel);
    NodeAssert.equal(sel.all, true, file);
    NodeAssert.deepEqual(sel.async, [], file);
  }
});

NodeTest.test("the app's package.json: a version bump alone is not an app change", () => {
  const file = "apps/hbots-mobile/package.json";
  const base = JSON.stringify({ name: "hbots", version: "1.67.55", dependencies: { a: "1" } });
  const bump = JSON.stringify({ name: "hbots", version: "1.67.56", dependencies: { a: "1" } });
  const dep = JSON.stringify({ name: "hbots", version: "1.67.56", dependencies: { a: "2" } });
  const read = (head) => (f, side) => (f === file ? (side === "base" ? base : head) : null);
  NodeAssert.deepEqual(selectFlows([file], read(bump)).blocking, CORE);
  NodeAssert.equal(selectFlows([file], read(dep)).all, true);
  NodeAssert.equal(selectFlows([file]).all, true, "unreadable is unsure");
});

NodeTest.test("drive.py is read per method", () => {
  const swap = (from, to) => {
    NodeAssert.ok(DRIVE.includes(from), `drive.py has ${from}`);
    return DRIVE.replace(from, to);
  };
  // One flow's own method (the first "no Settings button" is flow 11's).
  NodeAssert.deepEqual(
    driveFlows(DRIVE, swap('"FAIL", "no Settings button on Chats"', '"FAIL", "no gear"')).flows,
    [11],
  );
  NodeAssert.deepEqual(
    driveFlows(
      DRIVE,
      swap("def f13_scroll_to(self, pat, tries=8", "def f13_scroll_to(self, pat, tries=9"),
    ).flows,
    [13],
  );
  // Shared code: every flow.
  const shared = driveFlows(DRIVE, swap("    def reset(self):", "    def reset(self):  # changed"));
  NodeAssert.equal(shared.flows, "all");
  NodeAssert.deepEqual(shared.shared, ["reset"]);
  NodeAssert.equal(driveFlows(DRIVE, swap("PAIR_WAIT = 40", "PAIR_WAIT = 41")).flows, "all");
  // Unchanged.
  NodeAssert.deepEqual(driveFlows(DRIVE, DRIVE).flows, []);
  // Through selectFlows.
  const read = (head) => (file, side) => (side === "base" ? DRIVE : head);
  const sel = selectFlows(
    [`${SKILL}scripts/drive.py`],
    read(swap("def f13_scroll_to(self, pat, tries=8", "def f13_scroll_to(self, pat, tries=9")),
  );
  NodeAssert.deepEqual(notCore(sel.blocking), [13]);
});

NodeTest.test(
  "a flow added to the run order is that flow's change; other flows() changes are shared",
  () => {
    const { entries } = flowOrder(driveParts(DRIVE).get("flows"));
    NodeAssert.ok(entries.length >= FLOWS.length);
    // Take flow 14 out of the base: the head adds it (and its method).
    const without14 = DRIVE.replace(/, \(14, "working-in-background", self\.f14\)/, "").replace(
      /\n    def f14\(self\):[\s\S]*?(?=\n    def flows\(self\):)/,
      "\n",
    );
    NodeAssert.notEqual(without14, DRIVE);
    NodeAssert.deepEqual(driveFlows(without14, DRIVE).flows, [14]);
    // A change to flows() outside the order list is shared.
    const loop = DRIVE.replace("seed_secs = 0\n", "seed_secs = 0.0\n");
    NodeAssert.notEqual(loop, DRIVE);
    NodeAssert.equal(driveFlows(DRIVE, loop).flows, "all");
  },
);

NodeTest.test("drive.py and the selector agree on the flows and their methods", () => {
  const parts = driveParts(DRIVE);
  const { entries } = flowOrder(parts.get("flows"));
  const order = entries.filter((entry) => !entry.startsWith("4s:"));
  NodeAssert.deepEqual(
    order.map((entry) => Number(entry.split(":")[0])),
    FLOWS,
    "FLOWS is drive.py's run order",
  );
  for (const entry of entries) {
    const fn = entry.split(":")[1];
    NodeAssert.ok(parts.has(fn), `drive.py defines ${fn}`);
    NodeAssert.ok(fn in DRIVE_METHODS, `select-flows.mjs maps ${fn}`);
  }
  for (const name of Object.keys(DRIVE_METHODS))
    NodeAssert.ok(parts.has(name), `DRIVE_METHODS names ${name}, which drive.py no longer has`);
  const fillers = DRIVE.match(/^F10_FILLERS = \(([\d, ]+)\)/m);
  NodeAssert.ok(fillers, "drive.py defines F10_FILLERS");
  NodeAssert.deepEqual(
    fillers[1].split(",").map(Number),
    F10_FILLERS,
    "the selector's F10_FILLERS is drive.py's",
  );
});

NodeTest.test("every app source file has a rule (none falls through)", () => {
  const root = NodePath.resolve(here, "../../../../../..");
  const walk = (dir) =>
    NodeFS.readdirSync(NodePath.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    );
  const files = walk("apps/hbots-mobile/src");
  NodeAssert.ok(files.length > 100);
  for (const file of files) NodeAssert.ok(ruleFor(file), file);
});

NodeTest.test(
  "drive.py's own Python tests pass (test_drive.py: prompt text, link loss, the flow 10 overlap)",
  () => {
    const r = NodeChildProcess.spawnSync("python3", ["-I", "-B", "test_drive.py"], {
      cwd: here,
      encoding: "utf8",
      timeout: 60_000,
    });
    NodeAssert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    NodeAssert.match(r.stderr, /\nOK\b/);
  },
);
