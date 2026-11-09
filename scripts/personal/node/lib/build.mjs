// Stage a release the way build.ps1 does: build the web client and server,
// verify the bundle, copy the dist and the runtime externals, write VERSION and
// client/version.txt. Staging never touches current.txt; only activate does.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { loadRepoEnv, readText, utcStamp } from "./util.mjs";

const REQUIRED_DIST = ["bin.mjs", "client/index.html", "claude-history-worker.mjs"];
const REQUIRED_PUBLIC_CONFIG = ["T3CODE_RELAY_URL", "T3CODE_CLERK_PUBLISHABLE_KEY"];
const OPTIONAL_PUBLIC_CONFIG = [
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
];

function git(repoRoot, args) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

function resolveVp(repoRoot) {
  const candidate = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
  if (NodeFS.existsSync(candidate)) return candidate;
  return null;
}

function runVp(repoRoot, args, nodeExe, env) {
  const vp = resolveVp(repoRoot);
  if (!vp) {
    throw new Error(
      "vite-plus (vp) is not installed in this checkout. Run the repo install first (vp i).",
    );
  }
  const firstLine = (readText(vp) || "").split(/\r?\n/, 1)[0] || "";
  const isScript = firstLine.startsWith("#!");
  const command = isScript && /node/.test(firstLine) ? nodeExe : vp;
  const commandArgs = command === vp ? args : [vp, ...args];
  const result = NodeChildProcess.spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not run vp: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`vp ${args.join(" ")} failed (exit ${result.status}).`);
}

export function assertPublicConfig(repoRoot) {
  const { values } = loadRepoEnv(repoRoot);
  const missing = REQUIRED_PUBLIC_CONFIG.filter((name) => !values[name]);
  if (missing.length) {
    throw new Error(
      `Build refused before it starts: the T3 Connect public config is empty (${missing.join(", ")}). ` +
        `Copy the repo .env into ${repoRoot} (gitignored; values are never printed) and rebuild.`,
    );
  }
  return values;
}

function readTextTree(directory) {
  if (!NodeFS.existsSync(directory)) return "";
  let text = "";
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const file = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) text += readTextTree(file);
    else if (/\.(?:mjs|cjs|js|html|css)$/iu.test(entry.name)) text += readText(file);
  }
  return text;
}

export function missingBakedPublicConfig({ binPath, clientDirectory, values }) {
  const binText = readText(binPath);
  if (!binText)
    throw new Error(`Cannot check the T3 Connect public config: ${binPath} is missing.`);
  const text =
    clientDirectory === undefined ? binText : `${binText}\n${readTextTree(clientDirectory)}`;
  const missing = [];
  for (const name of REQUIRED_PUBLIC_CONFIG) {
    if (!values[name] || !text.includes(values[name])) missing.push(name);
  }
  for (const name of OPTIONAL_PUBLIC_CONFIG) {
    if (values[name] && !text.includes(values[name])) missing.push(name);
  }
  return missing;
}

function upstreamBase(repoRoot) {
  try {
    return git(repoRoot, ["merge-base", "HEAD", "upstream/main"]).slice(0, 12);
  } catch {
    return "";
  }
}

export function stageRelease({
  repoRoot,
  paths,
  copyExternals = false,
  skipBuild = false,
  releaseName = null,
  nodeExe = process.execPath,
  builtAt = new Date(),
  verifyExternals = true,
}) {
  const envValues = assertPublicConfig(repoRoot);
  const sha = git(repoRoot, ["rev-parse", "--short=12", "HEAD"]);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyLines = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = Boolean(dirtyLines);
  let name = releaseName || sha;
  if (dirty && !releaseName) {
    const p = (n) => String(n).padStart(2, "0");
    name = `${sha}-dirty-${builtAt.getFullYear()}${p(builtAt.getMonth() + 1)}${p(builtAt.getDate())}${p(builtAt.getHours())}${p(builtAt.getMinutes())}${p(builtAt.getSeconds())}`;
  }

  if (!skipBuild) {
    process.stdout.write("Building web client and server (vp run --filter t3 build)...\n");
    const env = { ...process.env };
    for (const [key, value] of Object.entries(envValues)) if (value) env[key] = value;
    Object.assign(env, {
      PATH: `${NodePath.join(repoRoot, "node_modules", ".bin")}${NodePath.delimiter}${env.PATH ?? ""}`,
    });
    runVp(repoRoot, ["run", "--filter", "t3", "build"], nodeExe, env);
  }

  const dist = NodePath.join(repoRoot, "apps", "server", "dist");
  for (const required of REQUIRED_DIST) {
    if (!NodeFS.existsSync(NodePath.join(dist, required)))
      throw new Error(`Build output is missing apps/server/dist/${required}.`);
  }
  const missing = missingBakedPublicConfig({
    binPath: NodePath.join(dist, "bin.mjs"),
    clientDirectory: NodePath.join(dist, "client"),
    values: envValues,
  });
  if (missing.length) {
    throw new Error(
      `Build refused: the server bundle is missing the T3 Connect public config (${missing.join(", ")}). ` +
        `It was built without the repo .env; copy it into ${repoRoot} and rebuild. Nothing was staged or activated.`,
    );
  }

  const releaseDir = NodePath.join(paths.releasesDir, name);
  const releaseDist = NodePath.join(releaseDir, "dist");
  NodeFS.mkdirSync(releaseDir, { recursive: true });
  NodeFS.rmSync(releaseDist, { recursive: true, force: true });
  NodeFS.cpSync(dist, releaseDist, { recursive: true, dereference: false });

  const releaseModules = NodePath.join(releaseDir, "node_modules");
  const serverModules = NodePath.join(repoRoot, "apps", "server", "node_modules");
  let externalsMode;
  if (copyExternals) {
    NodeFS.rmSync(releaseModules, { recursive: true, force: true });
    process.stdout.write("Copying runtime externals into the release...\n");
    const result = NodeChildProcess.spawnSync(
      nodeExe,
      [
        "--disable-warning=ExperimentalWarning",
        NodePath.join(repoRoot, "scripts", "personal", "copy-externals.mjs"),
        NodePath.join(repoRoot, "apps", "server"),
        releaseModules,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0)
      throw new Error(
        `copy-externals.mjs failed (exit ${result.status}): ${(result.stderr || "").trim()}`,
      );
    externalsMode = "copied";
  } else if (!NodeFS.existsSync(releaseModules)) {
    NodeFS.symlinkSync(
      serverModules,
      releaseModules,
      process.platform === "win32" ? "junction" : "dir",
    );
    externalsMode = "junction";
  } else {
    externalsMode = NodeFS.lstatSync(releaseModules).isSymbolicLink() ? "junction" : "copied";
  }

  // Externals must resolve from the release before it can be called staged.
  let cliText = "";
  if (verifyExternals) {
    const resolveResult = NodeChildProcess.spawnSync(
      nodeExe,
      [
        "-e",
        `const r=require('node:module').createRequire(${JSON.stringify(NodePath.join(releaseDist, "bin.mjs"))});r.resolve('node-pty');r.resolve('playwright-core')`,
      ],
      { encoding: "utf8" },
    );
    if (resolveResult.status !== 0) {
      throw new Error(
        `node-pty or playwright-core does not resolve from ${releaseDir}. Check ${releaseModules}.`,
      );
    }
    const cli = NodeChildProcess.spawnSync(
      nodeExe,
      [NodePath.join(releaseDist, "bin.mjs"), "--version"],
      { encoding: "utf8" },
    );
    if (cli.status !== 0)
      throw new Error(`The staged CLI failed to start (t3 --version exited ${cli.status}).`);
    cliText = String(cli.stdout).trim();
  }

  const appVersionFile = NodePath.join(repoRoot, "scripts", "personal", "app-version.txt");
  const appVersion = (readText(appVersionFile) || "").split(/\r?\n/)[0].trim();
  const builtAtText = utcStamp(builtAt);
  const version = [
    `version=${appVersion}`,
    `release=${name}`,
    `sha=${sha}`,
    `branch=${branch}`,
    `dirty=${dirty}`,
    `builtAt=${builtAtText}`,
    `cli=${cliText}`,
    `node=${process.version}`,
    `upstream=${upstreamBase(repoRoot)}`,
    `externals=${externalsMode}`,
    `repo=${repoRoot}`,
  ];
  NodeFS.writeFileSync(NodePath.join(releaseDir, "VERSION"), `${version.join("\n")}\n`);
  const indexHtml = readText(NodePath.join(releaseDist, "client", "index.html")) || "";
  const match = indexHtml.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  const clientEntry = match ? match[1] : "";
  NodeFS.writeFileSync(
    NodePath.join(releaseDist, "client", "version.txt"),
    `${[...version, `client=${clientEntry}`].join("\n")}\n`,
  );

  return {
    name,
    dir: releaseDir,
    sha,
    branch,
    dirty,
    version: appVersion,
    builtAt: builtAtText,
    externalsMode,
    clientEntry,
  };
}
