#!/usr/bin/env node
// Which emulator flows run before a phone release (blocking) and which after live (async).
// Core, always blocking: setup, flow 1 and flow 8. Anything unsure runs every flow before the release.
//   node select-flows.mjs --repo <root> --base <live release sha> --head <tested sha> [--json | --list blocking|async]
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const FLOWS = [1, 7, 9, 3, 2, 5, 4, 6, 8, 10, 11, 12, 13, 14];
/** drive.py's F10_FILLERS. */
export const F10_FILLERS = [1, 7, 9, 3, 2, 11, 13, 12];
export const CORE = [1, 8];
const ALL = "all";
const SKILL = "apps/hbots-mobile/.claude/skills/verify-hbots-android/";
const APP = "apps/hbots-mobile/";
const SRC = "apps/hbots-mobile/src/";
const PC = "packages/personal-client/src/";
const SERVER = "apps/server/src/";

// Chat flows: everything that opens a chat and reads it.
const CHAT = [7, 9, 3, 2, 10, 12, 14];
const ROWS = [6, 10, 14]; // what a Chats row says: reply preview, Needs approval, Working in background
const TASKS = [5, 4, 8];
const CARDS = [10, 12, 14, 4];

// [pattern, flows, why]. A string ending in "/" is a prefix, other strings are exact paths,
// a RegExp is tested against the whole path. The first matching row wins, so specific rows
// come before broad ones. ALL means every flow blocks.
export const RULES = [
  // Never in the app: docs and unit tests (the gates run the tests).
  [/\.md$/, [], "a document"],
  [/\.test\.(ts|tsx|mts|mjs|js|py)$|(^|\/)test_[^/]+\.py$/, [], "a unit test"],
  [/(^|\/)(__tests__|__mocks__|testFixtures|fixtures)\//, [], "a test fixture"],

  // A DB migration runs every gate before the release (guard 2); every flow too.
  [/^apps\/server\/src\/persistence\/Migrations/, ALL, "a DB migration (full gates)"],

  // The harness itself. A change to one flow's code in drive.py is read per method (below);
  // every other harness file can change every flow.
  [`${SKILL}scripts/drive.py`, "drive.py", "drive.py, per changed method"],
  [`${SKILL}scripts/select-flows.mjs`, ALL, "the flow selector itself"],
  [SKILL, ALL, "the emulator harness"],
  ["scripts/personal/testing/fake-claude/", ALL, "the fake Claude CLI every flow talks to"],

  // Release tooling that runs every check whole; the emulator follows the gates.
  ["scripts/personal/linux/hbots-release/", ALL, "the release tools (full gates)"],
  ["scripts/personal/linux/dev-team-tools/", ALL, "the release tools (full gates)"],
  [/^scripts\/personal\/node\/gates-linux/, ALL, "the gate definitions (full gates)"],

  // App: chat features.
  [new RegExp(`^${SRC}chat/cards/(ToolApprovalCard)`), [10], "tool approval card"],
  [
    new RegExp(
      `^${SRC}chat/cards/(SecretRequestCard|SecretAccessFields|secretRequestCardModel|passwordField)`,
    ),
    [12],
    "secret card",
  ],
  [new RegExp(`^${SRC}chat/(secretOutcome)`), [12], "secret card outcome"],
  [new RegExp(`^${SRC}chat/cards/DelegationCard`), [14], "delegation card"],
  [new RegExp(`^${SRC}chat/cards/QuestionCard|^${SRC}chat/ChoiceButtons`), [4, 8], "question card"],
  [
    new RegExp(`^${SRC}chat/cards/(registry|cardKinds|types|cardStyles)|^${SRC}chat/useChatCards`),
    CARDS,
    "chat cards (shared)",
  ],
  [`${SRC}chat/cards/`, [], "a chat card no flow shows"],
  [
    new RegExp(
      `^${SRC}chat/([Aa]ttach|PhotoStrip|photo|localImages|outgoingFiles|uploadProgress|outboxNative|[Cc]amera|hbotsCamera|videoDrafts|useCameraRecovery)`,
    ),
    [3, 2],
    "attach sheet and photos",
  ],
  [new RegExp(`^${SRC}chat/([Cc]omposer)`), [7, 9, 3, 2], "composer"],
  [
    new RegExp(
      `^${SRC}chat/([Mm]essage|swipeTime|markdown|readerDoc|jumpToLatest|chatStreamPerf|useStreamCommitPerf|textSelectNative|ChipPill|chip|useFreshChipIds)`,
    ),
    // Every chat flow reads the list, and it also puts a card on screen: the chat opens at a pending
    // card (flow 10) and the card stays above the keyboard (flow 12), both MessageList's scrollToCard.
    CHAT,
    "message list (every chat flow; it also scrolls a card into view)",
  ],
  [`${SRC}chat/`, CHAT, "the chat screen"],
  [`${SRC}screens/ChatScreen.tsx`, CHAT, "the chat screen"],
  [new RegExp(`^${SRC}screens/(ChatsListScreen|chatsListTagPress)`), ROWS, "the Chats list"],
  [
    new RegExp(`^${SRC}screens/(BotNewChatScreen|newChatStart|BotPicker|chatLoadRetry)`),
    CHAT,
    "opening a chat",
  ],

  // App: lists, tasks, work, presence, push.
  [
    new RegExp(`^${SRC}shell/(BotsScreen|botsHome|pinnedOrderModel|openChat|BotAvatar)`),
    ROWS,
    "the Bots list",
  ],
  [new RegExp(`^${SRC}shell/(InApp|inAppBanner)`), [5, 6], "in-app presence and banners"],
  [`${SRC}bots/`, ROWS, "bot rows and threads"],
  [`${SRC}tasks/`, TASKS, "the Tasks tab"],
  [`${SRC}work/`, TASKS, "the Work view"],
  [`${SRC}notifications/`, [5, 6], "push and notifications"],
  [`${SRC}computer/`, [8], "the Computer tab"],
  [`${SRC}files/`, [8], "the Files tab"],

  // App: settings.
  [new RegExp(`^${SRC}settings/(RestartLaptop|restartLaptopModel)`), [11], "Restart laptop"],
  [
    new RegExp(`^${SRC}settings/(Email|emailScreenModel|Connections)`),
    [13],
    "Email and Integrations",
  ],
  [
    new RegExp(`^${SRC}settings/(SettingsScreen|SettingsUi|settingsScreenModel)`),
    [11, 13],
    "the Settings screen",
  ],
  [`${SRC}settings/`, [], "a Settings page no flow opens"],

  // personal-client.
  [`${PC}bots/`, [5, ...ROWS], "bot summaries (row status, presence)"],
  [new RegExp(`^${PC}conversation/toolApprovalCards`), [10], "tool approval cards"],
  [new RegExp(`^${PC}conversation/delegationModel`), [14], "delegation model"],
  [`${PC}conversation/`, CHAT, "the conversation model"],
  [`${PC}work/`, TASKS, "the Work timeline"],
  [`${PC}connections/`, [13], "connections"],

  // Server features the flows reach. Other server code is covered by the core and the gates
  // (a server-only release runs no emulator at all).
  [`${SERVER}personal/approvals/`, [10], "server approvals"],
  [`${SERVER}personal/system/`, [11], "server Restart laptop"],
  [`${SERVER}personal/connections/`, [13], "server connections"],
  [new RegExp(`^${SERVER}personal/(secret|.*[Ss]ecret)`), [12], "server secrets"],
  [
    new RegExp(`^${SERVER}personal/(notifications|push|presence)`),
    [5, 6],
    "server push and presence",
  ],
  [new RegExp(`^${SERVER}personal/(tasks|delegat)`), [14], "server tasks"],
  [`${SERVER}assets/`, [2], "server attachments"],
  [`${SERVER}`, [], "server code no flow targets (core and gates)"],
  [/^packages\/contracts\//, ALL, "the shared contracts"],

  // Everything else the app is built from: unsure, so every flow.
  [SRC, ALL, "app code shared by every screen"],
  [APP, ALL, "the app build (config, native modules, build scripts)"],
  [/^packages\//, ALL, "a workspace package"],
  [
    /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.npmrc|tsconfig\.base\.json|patches\/)/,
    ALL,
    "the toolchain",
  ],
];

// drive.py methods to flows. A method not listed here (setup, pair, reset, open_bot, say,
// flows, the module constants ...) is shared, so a change to it runs every flow.
export const DRIVE_METHODS = {
  f1: [1],
  f7: [7],
  f9: [9],
  long_press_reply: [9],
  f3: [3],
  f2: [2],
  f4_seed: [4, 8],
  f5: [5],
  wait_paths: [5, 6],
  f4: [4],
  f6: [6],
  f8: [8],
  approval_card: [10],
  ask_approval: [10],
  f10: [10],
  f10_tail: [10],
  finish_f10: [10],
  f10_start: [10],
  restart_row: [11],
  f11: [11],
  secret_card: [12],
  secret_fields: [12],
  card_to_top: [12],
  card_to_bottom: [12],
  f12: [12],
  f13_find: [13],
  f13_scroll_to: [13],
  f13: [13],
  f14_open_lead: [14],
  f14: [14],
  // The offline-draft probe is not a verification flow.
  attach_three: [],
  draft_state: [],
  tap_live_send: [],
  wait_arrival: [],
  probe_offline_draft: [],
};

const matches = (file, pattern) =>
  pattern instanceof RegExp
    ? pattern.test(file)
    : pattern.endsWith("/")
      ? file.startsWith(pattern)
      : file === pattern;

/** The first RULES row a path matches, as {flows, why}; flows is ALL, "drive.py" or a list. */
export function ruleFor(file) {
  for (const [pattern, flows, why] of RULES) if (matches(file, pattern)) return { flows, why };
  return null;
}

/** drive.py split into named parts: each Run method by name, the rest as "(module)". */
export function driveParts(source) {
  const parts = new Map();
  let name = "(module)";
  let inRun = false;
  const add = (line) => parts.set(name, (parts.get(name) ?? "") + line + "\n");
  for (const line of String(source ?? "").split("\n")) {
    if (/^class Run\b/.test(line)) {
      inRun = true;
      name = "(module)";
      add(line);
      continue;
    }
    const method = /^ {4}def (\w+)\(/.exec(line);
    if (inRun && method) name = method[1];
    else if (/^\S/.test(line)) {
      // a top-level line ends the class body
      if (!/^class Run\b/.test(line)) inRun = false;
      name = "(module)";
    }
    add(line);
  }
  return parts;
}

/** Flows a drive.py change touches, from the base and head sources: a list, or ALL with the shared parts named. */
export function driveFlows(before, after) {
  const a = driveParts(before);
  const b = driveParts(after);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter(
    (key) => a.get(key) !== b.get(key),
  );
  // flows() holds the run order. A flow added to (or moved in) that list is that flow's own
  // change; any other change to flows() is shared.
  const extra = [];
  const flowsAt = changed.indexOf("flows");
  if (flowsAt >= 0) {
    const x = flowOrder(a.get("flows"));
    const y = flowOrder(b.get("flows"));
    if (x.rest === y.rest) {
      changed.splice(flowsAt, 1);
      const was = new Map(x.entries.map((entry, i) => [entry, i]));
      const prevOf = (list, i) => (i > 0 ? list[i - 1] : null);
      for (const [i, entry] of y.entries.entries()) {
        const moved = !was.has(entry) || prevOf(x.entries, was.get(entry)) !== prevOf(y.entries, i);
        const flow = Number(entry.split(":")[0]);
        if (moved && FLOWS.includes(flow)) extra.push(flow);
        else if (moved && entry.startsWith("4s:")) extra.push(4, 8);
      }
      if (extra.length) changed.push("flows order");
    }
  }
  const shared = changed.filter((key) => key !== "flows order" && !(key in DRIVE_METHODS));
  if (shared.length) return { flows: ALL, changed, shared };
  return {
    flows: [
      ...new Set([
        ...changed.filter((key) => key in DRIVE_METHODS).flatMap((key) => DRIVE_METHODS[key]),
        ...extra,
      ]),
    ],
    changed,
    shared,
  };
}

/** flows() as its order entries ("10:f10", "4s:f4_seed") and the rest of its body. */
export function flowOrder(body) {
  const text = String(body ?? "");
  const m = /\n {8}order = \[[\s\S]*?\]\n/.exec(text);
  if (!m) return { entries: [], rest: text };
  const entries = [
    ...m[0].matchAll(/\(\s*"?(\w+)"?\s*,\s*(?:"[^"]*"|None)\s*,\s*self\.(\w+)\s*\)/g),
  ].map(([, flow, fn]) => `${flow}:${fn}`);
  return { entries, rest: text.replace(m[0], "\n<order>\n") };
}

const versionOnly = (before, after) => {
  try {
    const x = JSON.parse(before);
    const y = JSON.parse(after);
    delete x.version;
    delete y.version;
    return JSON.stringify(x) === JSON.stringify(y);
  } catch {
    return false;
  }
};

/**
 * The split for a diff. `read(file, "base"|"head")` returns a file's text or null.
 * Returns { all, blocking, async, why: [{file, flows, why}] } with flows in run order.
 */
export function selectFlows(changedPaths, read = () => null) {
  const why = [];
  let all = false;
  const picked = new Set(CORE);
  for (const file of changedPaths) {
    let rule = ruleFor(file);
    if (file === `${APP}package.json` && versionOnly(read(file, "base"), read(file, "head")))
      rule = { flows: [], why: "version bump only" };
    if (!rule) {
      // Not a path the app or a flow reads (a release note, an upstream folder ...).
      continue;
    }
    let flows = rule.flows;
    let reason = rule.why;
    if (flows === "drive.py") {
      const d = driveFlows(read(file, "base") ?? "", read(file, "head") ?? "");
      flows = d.flows;
      reason = d.shared.length
        ? `drive.py shared code changed (${d.shared.slice(0, 4).join(", ")})`
        : `drive.py ${d.changed.join(", ") || "unchanged"}`;
    }
    if (flows === ALL) all = true;
    else for (const flow of flows) picked.add(flow);
    if (flows === ALL || flows.length) why.push({ file, flows, why: reason });
  }
  // Flow 10 waits 2 minutes for the server's auto-decline; drive.py runs these flows inside that wait,
  // so they cost no wall time when 10 runs before the release.
  if (picked.has(10)) for (const flow of F10_FILLERS) picked.add(flow);
  const blocking = all ? [...FLOWS] : FLOWS.filter((flow) => picked.has(flow));
  return { all, blocking, async: FLOWS.filter((flow) => !blocking.includes(flow)), why };
}

/** One line for a log: what blocks, why, and what runs after live. */
export function describe(sel) {
  const reasons = sel.why
    .slice(0, 6)
    .map((row) => `${row.file} -> ${row.flows === ALL ? "all" : row.flows.join(",")} (${row.why})`);
  return [
    `emulator flows before the release: ${sel.blocking.join(",")}${sel.all ? " (every flow: an unsure or shared change)" : ` (core ${CORE.join(",")} plus the touched flows)`}`,
    `emulator flows after live (async tier): ${sel.async.join(",") || "none"}`,
    ...reasons.map((line) => `  ${line}`),
    ...(sel.why.length > 6 ? [`  ... ${sel.why.length - 6} more`] : []),
  ].join("\n");
}

function git(repo, args) {
  return NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main() {
  const { values: o } = NodeUtil.parseArgs({
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      json: { type: "boolean" },
      list: { type: "string" },
    },
  });
  if (!o.repo || !o.base || (o.list && !["blocking", "async"].includes(o.list))) {
    console.error(
      "usage: select-flows.mjs --repo <root> --base <sha> [--head <sha>] [--json | --list blocking|async]",
    );
    process.exit(2);
  }
  const changed = git(o.repo, ["diff", "--no-renames", "--name-only", o.base, o.head])
    .split("\n")
    .filter(Boolean);
  const read = (file, side) => {
    try {
      return git(o.repo, ["show", `${side === "base" ? o.base : o.head}:${file}`]);
    } catch {
      return null;
    }
  };
  const sel = selectFlows(changed, read);
  if (o.list) console.log(sel[o.list].join(","));
  else if (o.json) console.log(JSON.stringify(sel, null, 1));
  else console.log(describe(sel));
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
