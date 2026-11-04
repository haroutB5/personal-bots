#!/usr/bin/env node
// Web-to-Android parity matrix for hbots.
// Reads the web app at a git ref (never the working tree), lists every screen, sheet,
// setting and user action, maps each to the program PR that ports it, and writes parity.json.
//
// Usage:
//   node parity-matrix.mjs <repo> [--ref personal-bots/main] [--android-ref feat/hbots-mobile-scaffold]
//                          [--out parity.json] [--check] [--require-done <PR id,...>] [--list <kind>]
//
// --check fails (exit 1) when a web item has no PR rule, which is how the gate catches a new
// web screen Android lacks. It also fails while an item routed to a PR in parity.ts MERGED_PRS
// is not done, which is how a new field in an already-ported web file fails the same build.
// --require-done adds PR ids to that set by hand. "done" comes from apps/hbots-mobile/src/parity.ts at the Android ref once that file
// exists (program PR G0), and from the measured DONE_TODAY table before then.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const repo = argv[0];
if (!repo || repo.startsWith("--")) {
  console.error(
    "Usage: node parity-matrix.mjs <repo> [--ref <ref>] [--android-ref <ref>] [--out <file>] [--check] [--require-done <ids>] [--list <kind>]",
  );
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const REF = opt("--ref", "personal-bots/main");
const ANDROID_REF = opt("--android-ref", "feat/hbots-mobile-scaffold");
const OUT = opt("--out", join(dirname(fileURLToPath(import.meta.url)), "parity.json"));
const CHECK = argv.includes("--check");
const REQUIRE_DONE = (opt("--require-done", "") || "").split(",").filter(Boolean);
const LIST = opt("--list", null);

const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
const lsTree = (ref, dir) => {
  try {
    return git("ls-tree", "-r", "--name-only", ref, dir).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const cache = new Map();
const show = (ref, path) => {
  const key = `${ref}:${path}`;
  if (!cache.has(key)) {
    try {
      cache.set(key, git("show", key));
    } catch {
      cache.set(key, null);
    }
  }
  return cache.get(key);
};

const WEB = "apps/web/src";
const PERSONAL = `${WEB}/features/personal`;
const ROUTES = `${WEB}/routes`;
const CONTRACTS = "packages/contracts/src";
const CLIENT = "packages/personal-client/src";
const MOBILE = "apps/hbots-mobile";

// Comments become blanks of the same length so offsets and line numbers stay true.
const blank = (m) => m.replace(/[^\n]/g, " ");
const stripComments = (src) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (m, p) => p + blank(m.slice(p.length)));
const lineAt = (src, index) => src.slice(0, index).split("\n").length;
const squash = (s) => s.replace(/\s+/g, " ").trim();
const slug = (s) =>
  squash(s)
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "x")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "untitled";
// Balanced-brace JSX helpers. A {expr} becomes its string literals joined by " / ", or nothing.
const skipBraces = (src, i) => {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return src.length;
};
const literalsOf = (expr) =>
  [...expr.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)]
    .map((m) => m[2].replace(/\$\{[^}]*\}/g, "x"))
    .filter(
      (t) =>
        /[A-Za-z]/.test(t) &&
        !/^[a-z-]+$/.test(t) &&
        !/\s(?:px|rem)\b|^(?:size|text|bg|flex)-/.test(t),
    );
const flattenExpr = (jsx) => {
  let out = "";
  for (let i = 0; i < jsx.length;) {
    if (jsx[i] === "{") {
      const end = skipBraces(jsx, i);
      const inner = jsx.slice(i, end);
      out += /=>|<[A-Za-z]/.test(inner) ? " " : ` ${literalsOf(inner).join(" / ")} `;
      i = end;
    } else out += jsx[i++];
  }
  return out;
};
// End index of an opening tag that starts at `at`, skipping attribute braces.
const openTagEnd = (src, at) => {
  for (let i = at; i < src.length;) {
    if (src[i] === "{") i = skipBraces(src, i);
    else if (src[i] === ">") return i + 1;
    else i++;
  }
  return src.length;
};
// Inner JSX of the element whose opening tag starts at `at`, up to its matching close tag.
const innerOf = (src, at, tag) => {
  const start = openTagEnd(src, at);
  if (src[start - 2] === "/") return { open: src.slice(at, start), inner: "" };
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])`, "g");
  re.lastIndex = start;
  let depth = 1;
  for (let m; (m = re.exec(src));) {
    if (m[1]) depth--;
    else if (src[openTagEnd(src, m.index) - 2] !== "/") depth++;
    if (depth === 0) return { open: src.slice(at, start), inner: src.slice(start, m.index) };
  }
  return { open: src.slice(at, start), inner: src.slice(start, start + 400) };
};
const textOf = (jsx) =>
  squash(
    flattenExpr(jsx)
      .replace(/<[^>]*>/g, " ")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&hellip;|…/g, "..."),
  );

const allPersonal = lsTree(REF, PERSONAL).filter(
  (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes("__snapshots__"),
);
const views = allPersonal.filter((p) => p.endsWith(".tsx"));
const routeFiles = lsTree(REF, ROUTES).filter((p) => p.endsWith(".tsx"));
const webSet = new Set([...lsTree(REF, WEB), ...lsTree(REF, CLIENT)]);
const rel = (p) => p.replace(`${PERSONAL}/`, "").replace(`${WEB}/`, "");

// Import graph over features/personal and routes, for "shared logic it needs" and RPC consumers.
const IMPORT = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const resolveSpec = (from, spec) => {
  let base;
  if (spec.startsWith("~/")) base = `${WEB}/${spec.slice(2)}`;
  else if (spec.startsWith("@hbots/personal-client/"))
    base = `${CLIENT}/${spec.slice("@hbots/personal-client/".length)}`;
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (webSet.has(c) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
};
const importsOf = new Map();
const importsFor = (file) => {
  if (!importsOf.has(file)) {
    const src = show(REF, file) ?? "";
    const out = [];
    for (const m of src.matchAll(IMPORT)) {
      const r = resolveSpec(file, m[1] ?? m[2]);
      if (r) out.push(r);
    }
    importsOf.set(file, [...new Set(out)]);
  }
  return importsOf.get(file);
};
const isLogic = (p) => (p.startsWith(PERSONAL) || p.startsWith(CLIENT)) && p.endsWith(".ts");
// Logic closure through .ts files only: a view's own logic, not other views' logic.
const logicClosure = (file) => {
  const seen = new Set();
  const stack = importsFor(file).filter(isLogic);
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const n of importsFor(f)) if (isLogic(n) && !seen.has(n)) stack.push(n);
  }
  return seen;
};

const items = [];
const ids = new Map();
const add = (kind, file, title, line, extra = {}) => {
  let id = `${kind}:${rel(file)}#${slug(title)}`;
  const n = (ids.get(id) ?? 0) + 1;
  ids.set(id, n);
  if (n > 1) id = `${id}-${n}`;
  items.push({ id, kind, title: squash(title), web: `${rel(file)}:${line}`, file, ...extra });
};

// 1. Screens: every route file. Upstream routes are the T3 developer view.
const PERSONAL_PATH = /^\/(bots|tasks|computer|files)(\/|$)/;
for (const file of routeFiles) {
  const src = show(REF, file);
  const m = src.match(/createFileRoute\(\s*["']([^"']+)["']\s*\)/) ?? src.match(/createRootRoute/);
  const path = m ? (m[1] ?? "__root") : rel(file);
  const component = src.match(/component:\s*([A-Z][A-Za-z0-9]*)/)?.[1] ?? null;
  const url = path.replace(/\/_[a-z]+/g, "").replace(/^\/_[a-z]+/, "") || "/";
  const layout = /<Outlet\b/.test(src);
  const scope =
    PERSONAL_PATH.test(url) || file.includes("/_personal")
      ? "personal"
      : /^\/(pair|connect)$/.test(url)
        ? "pairing"
        : "developer-view";
  add(
    "screen",
    file,
    url === "/" && path !== "/" ? path.replace(/^\/_?/, "") : url,
    lineAt(src, m?.index ?? 0),
    { route: url, component, layout, scope },
  );
}
// Screens a route does not render directly (shell states, offline, unreachable).
const routedComponents = new Set(routeFiles.flatMap((f) => importsFor(f)));
for (const file of views) {
  if (/Screen\.tsx$/.test(file) && !routedComponents.has(file)) {
    add("screen", file, file.split("/").pop().replace(".tsx", ""), 1, {
      route: null,
      scope: "personal",
      layout: false,
    });
  }
}

// 2. Sheets and dialogs. A declared *Sheet or *Dialog component is one item. A bare root
// Sheet, AlertDialog or Dialog outside such a component is one item too. Title from its Title element.
const titleIn = (body, fallback) => {
  const t = body.match(/<((?:Sheet|AlertDialog|Dialog)Title)(?=[\s>])/);
  const text = t ? textOf(innerOf(body, t.index, t[1]).inner) : "";
  return text.length >= 3 ? text : fallback;
};
for (const file of views) {
  const src = stripComments(show(REF, file));
  const decls = [
    ...src.matchAll(
      /^(?:export\s+)?(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*(?:Sheet|Dialog))\s*\(/gm,
    ),
  ];
  const ranges = decls.map((d, i) => [d.index, decls[i + 1]?.index ?? src.length]);
  decls.forEach((d, i) => {
    const body = src.slice(...ranges[i]);
    if (!/<(Sheet|AlertDialog|Dialog|[A-Z][A-Za-z]*Sheet)[\s>]/.test(body)) return;
    add("sheet", file, titleIn(body, d[1]), lineAt(src, d.index), { component: d[1] });
  });
  const roots = [...src.matchAll(/<(Sheet|AlertDialog|Dialog)(?=[\s>])/g)].filter(
    (r) => !ranges.some(([a, b]) => r.index >= a && r.index < b),
  );
  roots.forEach((r, i) => {
    const body = src.slice(r.index, roots[i + 1]?.index ?? src.length);
    add(
      "sheet",
      file,
      titleIn(body, `${r[1]} in ${file.split("/").pop().replace(".tsx", "")}`),
      lineAt(src, r.index),
      { primitive: r[1] },
    );
  });
}

// 3. Menu actions: every MenuItem with its label.
for (const file of views) {
  const src = stripComments(show(REF, file));
  for (const m of src.matchAll(/<(Menu(?:Radio|Checkbox)?Item)(?=[\s>])/g)) {
    const { open, inner } = innerOf(src, m.index, m[1]);
    const label =
      textOf(inner) ||
      literalsOf(open.match(/aria-label=(\{[^}]*\}|"[^"]*")/)?.[1] ?? "").join(" ") ||
      "menu item";
    add("action", file, label, lineAt(src, m.index), { via: "menu" });
  }
}

// 4. Gestures: long press, swipes, drags and resize handles.
const GESTURES = [
  [/\buseLongPress\(/g, "long press"],
  [/\buseMessageSwipe\(/g, "swipe a message to reply or see its time"],
  [/<SwipeToDelete\b/g, "swipe to delete"],
  [/\buseChatSwipeBack\(/g, "edge swipe back"],
  [/\buseTeamBotDrag\(/g, "drag a bot between teams"],
  [/\buseSheetDragDismiss\(/g, "drag a sheet down to close"],
  [/<ColumnResizeHandle\b/g, "drag to resize the desktop column"],
];
for (const file of views) {
  const src = stripComments(show(REF, file));
  for (const [re, label] of GESTURES) {
    for (const m of src.matchAll(re))
      add("action", file, label, lineAt(src, m.index), { via: "gesture" });
  }
}

// 5. Cards in the chat feed and other card surfaces.
for (const file of views) {
  const name = file.split("/").pop().replace(".tsx", "");
  if (/(Card|Panel|Strip|Banner)$/.test(name)) add("card", file, name, 1);
}

// 6. Settings: Settings screen sections and rows, labelled form fields, stored preferences.
{
  const file = `${PERSONAL}/PersonalSettingsScreen.tsx`;
  const src = stripComments(show(REF, file));
  for (const s of src.matchAll(
    /<section aria-labelledby="settings-([a-z-]+)"[\s\S]*?<\/section>/g,
  )) {
    const section = textOf(s[0].match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? s[1]);
    add("setting", file, `${section} (section)`, lineAt(src, s.index), { section });
    const body = s[0];
    const rows = [
      ...[...body.matchAll(/\blabel(?:=|:\s*)"([^"]+)"/g)].map((m) => [m[1], m.index]),
      ...[...body.matchAll(/font-semibold text-\[var\(--personal-text\)\]">([^<{]+)/g)].map((m) => [
        m[1],
        m.index,
      ]),
      ...[...body.matchAll(/<([A-Z][A-Za-z]+(?:Row|Control|Section|Form))\b/g)]
        .filter((m) => !/\blabel=/.test(innerOf(body, m.index, m[1]).open))
        .map((m) => [m[1], m.index]),
    ];
    const seen = new Set();
    for (const [title, at] of rows.sort((a, b) => a[1] - b[1])) {
      if (squash(title) && !seen.has(title) && seen.add(title))
        add("setting", file, `${section} / ${title}`, lineAt(src, s.index + at), { section });
    }
  }
  const providers = `${PERSONAL}/PersonalProvidersSection.tsx`;
  const psrc = show(REF, providers);
  if (psrc) add("setting", providers, "Providers (section)", 1, { section: "Providers" });
}
for (const file of views) {
  if (file.endsWith("PersonalSettingsScreen.tsx")) continue;
  const src = stripComments(show(REF, file));
  for (const m of src.matchAll(/<(label|legend)(?=[\s>])/g)) {
    const label =
      textOf(innerOf(src, m.index, m[1]).inner) ||
      `Field with a data-driven label in ${file.split("/").pop().replace(".tsx", "")}`;
    add("setting", file, label, lineAt(src, m.index), { via: "field" });
  }
}
{
  const file = `${PERSONAL}/personalPreferences.ts`;
  const src = show(REF, file) ?? "";
  const block = src.match(/DEFAULT[A-Z_]*\s*[:=][^{]*\{([\s\S]*?)\}/);
  for (const m of (block?.[1] ?? "").matchAll(/^\s*([a-zA-Z]+)\s*:/gm)) {
    add("pref", file, m[1], lineAt(src, block.index + m.index), { storage: "browser" });
  }
  const push = `${CONTRACTS}/personalPush.ts`;
  const psrc = show(REF, push) ?? "";
  const pblock = psrc.match(/PersonalPushPreferences = Schema\.Struct\(\{([\s\S]*?)\}\);/);
  for (const m of (pblock?.[1] ?? "").matchAll(/^\s*([a-zA-Z]+)\s*:/gm)) {
    items.push({
      id: `pref:push#${m[1]}`,
      kind: "pref",
      title: m[1],
      web: `${push}:${lineAt(psrc, pblock.index + m.index)}`,
      file: push,
      storage: "server",
    });
  }
  const bots = `${CONTRACTS}/personalBots.ts`;
  const bsrc = show(REF, bots) ?? "";
  const prof = bsrc.match(/PersonalProfileSetInput = Schema\.Struct\(\{([\s\S]*?)\n\}\);/);
  for (const m of (prof?.[1] ?? "").matchAll(/^ {2}([a-zA-Z]+)\s*:/gm)) {
    items.push({
      id: `pref:profile#${m[1]}`,
      kind: "pref",
      title: m[1],
      web: `${bots}:${lineAt(bsrc, prof.index + m.index)}`,
      file: bots,
      storage: "server",
    });
  }
}

// 7. RPC: every personal WS method the web calls, with its kind and the views that reach it.
const contract = show(REF, `${CONTRACTS}/rpc.ts`) ?? "";
const contractMethods = [...contract.matchAll(/^ {2}(personal[A-Za-z]+):\s*"([^"]+)"/gm)].map(
  (m) => ({ key: m[1], wire: m[2], line: lineAt(contract, m.index) }),
);
const webFiles = [...lsTree(REF, WEB), ...lsTree(REF, CLIENT)].filter(
  (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p),
);
const rpcDefs = new Map();
for (const file of webFiles) {
  const src = show(REF, file);
  if (!src.includes("WS_METHODS.personal")) continue;
  for (const m of src.matchAll(/WS_METHODS\.(personal[A-Za-z]+)/g)) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const ctor = [
      ...before.matchAll(
        /create(EnvironmentRpc(?:Command|QueryAtomFamily|SubscriptionAtomFamily))/g,
      ),
    ].at(-1)?.[1];
    const kind = ctor?.includes("Command")
      ? "command"
      : ctor?.includes("Subscription")
        ? "subscription"
        : ctor
          ? "query"
          : "direct";
    if (!rpcDefs.has(m[1])) rpcDefs.set(m[1], { kind, defs: [] });
    rpcDefs.get(m[1]).defs.push({ path: file, line: lineAt(src, m.index) });
  }
}
const viewReaches = new Map(views.map((v) => [v, new Set([v, ...logicClosure(v)])]));
for (const [key, def] of rpcDefs) {
  const defFiles = def.defs.map((d) => d.path);
  const users = views.filter((v) => defFiles.some((f) => viewReaches.get(v).has(f)));
  const c = contractMethods.find((x) => x.key === key);
  const first = def.defs[0];
  items.push({
    id: `rpc:${key}`,
    kind: "rpc",
    title: `${key} (${def.kind})`,
    web: `${rel(first.path)}:${first.line}`,
    file: first.path,
    rpcKind: def.kind,
    wire: c?.wire ?? null,
    contract: c ? `${CONTRACTS}/rpc.ts:${c.line}` : null,
    views: users.map(rel),
    ...(def.kind === "command" ? { userAction: true } : {}),
  });
}
const serverOnlyMethods = contractMethods.filter((m) => !rpcDefs.has(m.key)).map((m) => m.key);

// Shared logic each item needs: its view's logic closure, split by where the file lives now.
const clientRef = opt("--client-ref", "origin/feat/hbots-personal-client");
const movedToClient = new Set(
  allPersonal.filter((p) => {
    const s = show(clientRef, p);
    return s !== null && /^export\s[^;]*from\s+["']@hbots\/personal-client\//m.test(s);
  }),
);
for (const it of items) {
  if (!it.file?.startsWith(PERSONAL) || !it.file.endsWith(".tsx")) continue;
  const closure = [...logicClosure(it.file)];
  it.logic = {
    files: closure.length,
    inPackage: closure.filter((f) => movedToClient.has(f)).map(rel),
    direct: importsFor(it.file).filter(isLogic).map(rel),
  };
}

// Program ownership. First matching rule wins; an item that matches nothing fails --check.
// Rules match "<kind> <web file relative to features/personal or src> <title>".
const NA = (reason) => ({ status: "n/a", reason });
const RULES = [
  [
    /^screen routes\/(?!_personal|pair|connect)/,
    NA(
      "Upstream T3 developer view (Settings > Developer view). Plan section 2 leaves terminal, diff, review and upstream settings out of the phone app.",
    ),
  ],
  [
    /^screen routes\/connect\.tsx/,
    NA(
      "T3 Connect browser linking. The phone pairs through the relay link instead (NETWORK-PATH.md, Relay design).",
    ),
  ],
  [/^screen routes\/pair\.tsx/, { pr: "A17" }],
  [/^screen routes\/_personal\.tsx/, { pr: "A1" }],
  [/^screen routes\/_personal\.bots\.tsx/, { pr: "A2" }],
  [/^screen routes\/_personal\.bots_\.\$botId\.\$threadId/, { pr: "A4" }],
  [/^screen routes\/_personal\.bots_\.(\$botId\.(edit|index)|new)\.tsx/, { pr: "A9" }],
  [/^screen routes\/_personal\.bots_\.groups\./, { pr: "A10" }],
  [/^screen routes\/_personal\.bots_\.(team|teams\.new|settings_\.removed)\.tsx/, { pr: "A11" }],
  [
    /^screen routes\/_personal\.bots_\.settings_\.(api-keys|connections|memory|passwords)\.tsx/,
    { pr: "A15" },
  ],
  [
    /^screen routes\/_personal\.bots_\.settings(_\.(notifications|providers\..*))?\.tsx/,
    { pr: "A14" },
  ],
  [/^screen routes\/_personal\.computer\.tsx/, { pr: "A16" }],
  [/^screen routes\/_personal\.files\.tsx/, { pr: "A13" }],
  [/^screen routes\/_personal\.tasks/, { pr: "A12" }],
  [
    /^setting PersonalSettingsScreen\.tsx Appearance/,
    NA("Android is dark only by the approved spec (SPEC.md section 0, plan section 4)."),
  ],
  [
    /^setting PersonalSettingsScreen\.tsx Advanced/,
    NA(
      "Developer view opens the upstream T3 UI and the diagnostics overlay is a laptop browser tool. Plan section 2 keeps both off the phone.",
    ),
  ],
  [
    /ColumnResizeHandle|desktopColumns|ConversationSidePanel|drag to resize the desktop column/,
    NA("Desktop side panel and column widths. The phone has one column at 360 dp."),
  ],
  [
    /DiagnosticsOverlay/,
    NA(
      "Developer diagnostics overlay for the laptop browser. Android sends crash and ANR data to client-diag instead (plan section 9).",
    ),
  ],
  [/^pref .*personalPreferences\.ts (showToolSteps|showRoutinesStrip)/, { pr: "L3b" }],
  [
    /^pref .*personalPreferences\.ts/,
    NA("Per-device layout or hint state. Stays per device on purpose (plan section 0)."),
  ],
  [/^pref .*personalPush\.ts/, { pr: "N1" }],
  [/^pref .*personalBots\.ts/, { pr: "A14" }],
  [/voice\/|Voice|[Cc]all[A-Z]/, { pr: "X4" }],
  [/computer\//, { pr: "A16" }],
  [/SecretRequestCard|SecretAccessFields|LoginRequestCard|ConnectionApprovalCard/, { pr: "A7" }],
  [
    /PasswordsScreen|ApiKeysScreen|PersonalConnectionsScreen|MemoryScreen|MemoryTidyPanels|MemoryContent/,
    { pr: "A15" },
  ],
  [
    /QuestionCard|ChoiceButtons|DelegationCard|WorkRecordCard|LeadBotChangeCard|MemoryChangeCard|NoteNoticeRow|RulesUsageCard|ProgressNoteLine|TeamMoveToast/,
    { pr: "A6" },
  ],
  [
    /Group(ConversationScreen|SettingsSheet|DeleteSheet|VoteCard|RoundCard|AvatarCluster|Row)|NewGroupScreen/,
    { pr: "A10" },
  ],
  [
    /Team(Screen|MembersSheet|LeadConfirm|MoveOverlay|ConstellationCard|WorkingNow)|NewTeam(Screen|Form)|RemovedBotsScreen/,
    { pr: "A11" },
  ],
  [/TasksScreen|TaskDetailScreen|Routine(DetailScreen|Form)/, { pr: "A12" }],
  [/FilesScreen|FilePreviewSheet|FileTextPreview/, { pr: "A13" }],
  [
    /BotThreadsScreen|BotForm|BotAvatarPicker|BotModel(Pick)?Fields|BotScheduleSection|BotFallbackSection|BotRoutinesSection/,
    { pr: "A9" },
  ],
  [
    /ChatSettingsSheet|ConversationRoutinesPanel|ContextUsedPanel|TokenUsageSection|BotUsageSheet|ConversationComputerLink|ConversationDesktopLine/,
    { pr: "A8" },
  ],
  [
    /PersonalComposer|MentionPopover|ReplyQuote|ReplyableMessage|AttachmentPreview|OutboxFlusher/,
    { pr: "A5" },
  ],
  [
    /MessageList|ConversationScreen|ConversationShellFirst|ConversationHeaderName|ConversationSubtitle|ChatChips|ChatHeaderCurrent|ToolDetails|ChatFilePreview|ChatLoadProblem|ArchivedChatBar|MessageSearchResults|MessageSwipeTime|swipe a message/,
    { pr: "A4" },
  ],
  [
    /SelectMode|SnoozeSheet|BotMute|SwipeToDelete|swipe to delete|NewChatDialog|RenameChatDialog|PinnedStrip/,
    { pr: "A3" },
  ],
  [
    /ChatsScreen|BotRow|ChatSectionRows|AllChatsCount|UnreadChatsBadge|PersonalUsageStrip|PersonalResetCredits|ProviderMixBar|UsageRangeControl|PersonalOfflineBanner|InAppNotifications|PersonalEmptyTab|BotAvatar|PinMark/,
    { pr: "A2" },
  ],
  [/PersonalUnreachableScreen/, { pr: "A1" }],
  [/PersonalShell|PersonalTabBar|RouteLoadError|edge swipe back|drag a sheet down/, { pr: "A1" }],
  [
    /PersonalSettingsScreen|PersonalProvidersSection|providers\/|UpdateStatusLine|SystemStatsLine|NotificationsScreen/,
    { pr: "A14" },
  ],
];
// RPC ownership by method name: the first PR whose screen needs the call. A new method matches
// nothing and fails --check until someone names its owner.
const RPC_RULES = [
  [
    /^personalPush(Subscribe|Unsubscribe)$/,
    NA(
      "Web Push subscription for the browser. Android registers an FCM token through personalPush.registerFcm instead (program PR S1).",
    ),
  ],
  [/^personalPush(ReportViewing|ReportForeground)$/, { pr: "N1" }],
  [/^personalPush(InApp|AckInApp)$/, { pr: "A2" }],
  [/^personalPush/, { pr: "A14" }],
  [/^personalBots(List|GetProfile|WorkingProgress|ThreadShells|TokenUsage)$/, { pr: "A2" }],
  [/^personalBots(CreateThread|ArchiveThreads?|DeleteThreads?|UpdateThreads)$/, { pr: "A3" }],
  [/^personalBots(ThreadFullText|SearchMessages|PrewarmThread)$/, { pr: "A4" }],
  [/^personalBots(Create|Update|Delete|RecheckProvider)$/, { pr: "A9" }],
  [/^personalBots(ListRemoved|Restore)$/, { pr: "A11" }],
  [/^personalBotsSetProfile$/, { pr: "A14" }],
  [/^personalBotsListFiles$|^personalFiles/, { pr: "A13" }],
  [/^personalGroups/, { pr: "A10" }],
  [/^personal(Tasks|Routines)/, { pr: "A12" }],
  [/^personalLeadBotChanges/, { pr: "A6" }],
  [
    /^personal(LoginRequests|ConnectionApprovals)|^personalSecrets(ListPending|Fulfill|Cancel)$/,
    { pr: "A7" },
  ],
  [/^personal(Memory|Logins|Connections|Secrets)/, { pr: "A15" }],
  [/^personal(Browser|Desktop)/, { pr: "A16" }],
  [/^personalVoiceCalls/, { pr: "X4" }],
];
const DONE_TODAY = {
  "rpc:personalBotsList": `${MOBILE}/src/rpc.ts:43`,
};
const PARTIAL_TODAY = {
  "screen:routes/pair.tsx#pair": `Paste-a-link pairing only (${MOBILE}/src/App.tsx:773). No QR scan, server confirm or device label.`,
  "screen:routes/_personal.bots.tsx#bots": `Read-only bot rows from the saved cache (${MOBILE}/src/App.tsx:115). No chats, taps or actions.`,
  "screen:routes/_personal.tsx#personal": `Shell states only: booting, connecting, "Can't reach your laptop", signed out, too old (${MOBILE}/src/App.tsx:718). No tabs or back stack.`,
};
const parityFile = show(ANDROID_REF, `${MOBILE}/src/parity.ts`);
// PRs already merged on the Android side. A web item routed to one of them must be done.
const mergedPrs = [
  ...(parityFile?.match(/MERGED_PRS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
    /["']([A-Z]\d*[a-z]?\d*)["']/g,
  ),
].map((m) => m[1]);
if (CHECK) for (const pr of mergedPrs) if (!REQUIRE_DONE.includes(pr)) REQUIRE_DONE.push(pr);
const androidDone = new Set(
  parityFile
    ? [
        ...parityFile.matchAll(/["']((?:screen|sheet|action|card|setting|pref|rpc):[^"']+)["']/g),
      ].map((m) => m[1])
    : [],
);

const unassigned = [];
for (const it of items) {
  const key = `${it.kind} ${rel(it.file)} ${it.title}`;
  const rule =
    it.kind === "rpc"
      ? RPC_RULES.find(([re]) => re.test(it.id.slice(4)))
      : RULES.find(([re]) => re.test(key));
  let owner = rule?.[1];
  if (!owner && it.kind === "setting" && it.file.endsWith("PersonalSettingsScreen.tsx"))
    owner = { pr: "A14" };
  if (!owner) {
    it.status = "unassigned";
    unassigned.push(it);
    continue;
  }
  if (owner.status === "n/a") {
    it.status = "n/a";
    it.reason = owner.reason;
    continue;
  }
  it.pr = owner.pr;
  const done = parityFile ? androidDone.has(it.id) : DONE_TODAY[it.id];
  it.status = done ? "done" : "planned";
  if (PARTIAL_TODAY[it.id]) it.androidToday = PARTIAL_TODAY[it.id];
}

const CHECKS = {
  screen: (it) =>
    `Open ${it.route ?? it.title} on the Android build. Every row, field, empty, loading and error state the web screen shows at 360 x 785 is present with the same data from the same server. Back follows SPEC.md section 7.`,
  sheet: (it) =>
    `Open "${it.title}" from its screen on Android. Same fields, buttons and confirm wording as ${it.web}. Back closes only the sheet.`,
  action: (it) =>
    it.via === "gesture"
      ? `Perform "${it.title}" on Android where ${it.web} offers it. The same result appears on the web app after a refresh.`
      : `Tap "${it.title}" on Android. The server state changes exactly as the web action at ${it.web} does, checked on the web app.`,
  card: (it) =>
    `A chat or screen that shows ${it.title} on web shows it on Android with the same text and buttons. Each button has the same server effect.`,
  setting: (it) =>
    `Change "${it.title}" on Android. The web app shows the new value after a refresh, and the reverse.`,
  pref: (it) =>
    it.storage === "server"
      ? `"${it.title}" set on one client reads the same on the other. Stored on the server.`
      : `"${it.title}" moves to the server and is shared by web and Android.`,
  rpc: (it) =>
    `Android calls ${it.wire ?? it.title} from ${it.views[0] ?? "its screen"} with the same input as web. A contract test in packages/personal-client pins the input shape.`,
};
for (const it of items) if (it.status !== "n/a") it.check = CHECKS[it.kind](it);

const count = (pred) => items.filter(pred).length;
const byKind = Object.fromEntries(
  [...new Set(items.map((i) => i.kind))].map((k) => [k, count((i) => i.kind === k)]),
);
const byStatus = Object.fromEntries(
  ["done", "planned", "n/a", "unassigned"].map((s) => [s, count((i) => i.status === s)]),
);
const byPr = {};
for (const it of items) if (it.pr) byPr[it.pr] = (byPr[it.pr] ?? 0) + 1;
const userActions = count((i) => i.kind === "action" || i.userAction);

const out = {
  generatedBy: "scripts/personal/parity/parity-matrix.mjs",
  web: { ref: REF },
  android: { ref: ANDROID_REF, registry: `${MOBILE}/src/parity.ts` },
  totals: {
    items: items.length,
    byKind,
    byStatus,
    userActions,
    byPr,
    rpcServerOnly: serverOnlyMethods.length,
    contractPersonalMethods: contractMethods.length,
  },
  serverOnlyMethods,
  items: items.map(({ file, ...rest }) => rest),
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
const formatter = join(repo, "node_modules/.bin/vp");
if (existsSync(formatter)) execFileSync(formatter, ["fmt", OUT], { stdio: "ignore" });

if (LIST)
  for (const it of items.filter((i) => i.kind === LIST || i.status === LIST || i.pr === LIST))
    console.log(`${it.status.padEnd(10)} ${(it.pr ?? "").padEnd(4)} ${it.id}  ${it.web}`);
console.log(`web ${REF}  android ${ANDROID_REF}  registry ${out.android.registry}`);
console.log(
  `items ${items.length}  ${Object.entries(byKind)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}  userActions=${userActions}`,
);
console.log(
  `status ${Object.entries(byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);
console.log(
  `by PR ${Object.entries(byPr)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);
console.log(
  `personal methods in contract ${contractMethods.length}, called by web ${rpcDefs.size}, server or other clients only ${serverOnlyMethods.length}`,
);
console.log(`wrote ${OUT}`);

let failed = false;
if (CHECK && unassigned.length) {
  failed = true;
  console.error(
    `FAIL ${unassigned.length} web items have no Android owner. Add a RULES entry with a PR id or an n/a reason:`,
  );
  for (const it of unassigned) console.error(`  ${it.id}  ${it.web}`);
}
if (REQUIRE_DONE.length) {
  const open = items.filter((i) => REQUIRE_DONE.includes(i.pr) && i.status !== "done");
  if (open.length) {
    failed = true;
    console.error(
      `FAIL ${open.length} items owned by ${REQUIRE_DONE.join(",")} are not in ${MOBILE}/src/parity.ts:`,
    );
    for (const it of open) console.error(`  ${it.pr} ${it.id}  ${it.web}`);
  }
}
process.exit(failed ? 1 : 0);
