// @effect-diagnostics nodeBuiltinImport:off - the fixture writes executable shell scripts that stand in for grim/hyprctl/notify-send and the helper.
/**
 * Test doubles for the Linux driver's outside world: four shell scripts on
 * PATH and a fake `pbdesk-wl` that speaks the real line protocol and records
 * every command it receives. Nothing here touches the live compositor.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** A valid 16x16 JPEG, so jpegSize() reads a real frame. */
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIYBsO//2Q==";

const script = (path: string, body: string): void => {
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  NodeFS.chmodSync(path, 0o755);
};

export interface FakeWorld {
  readonly binDir: string;
  readonly log: string;
  readonly helperLog: string;
  readonly notifyLog: string;
  readonly workDir: string;
  setActiveWindow(window: Record<string, unknown>): void;
  setClients(clients: ReadonlyArray<Record<string, unknown>>): void;
  setLayout(layout: string): void;
  setLocked(locked: boolean): void;
  helperCommands(): string[];
  helperPath: string;
}

/**
 * Writes the fakes into `workDir`, with `binary` a script that behaves like
 * pbdesk-wl (or a custom one). Caller puts `binDir` on PATH.
 */
export function makeFakeWorld(workDir: string, binary?: string): FakeWorld {
  const binDir = NodePath.join(workDir, "bin");
  const fixtureDir = NodePath.join(workDir, "fixture");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.mkdirSync(fixtureDir, { recursive: true });
  const log = NodePath.join(workDir, "hyprctl.log");
  const helperLog = NodePath.join(workDir, "helper.log");
  const notifyLog = NodePath.join(workDir, "notify.log");
  NodeFS.writeFileSync(log, "");
  NodeFS.writeFileSync(helperLog, "");
  NodeFS.writeFileSync(notifyLog, "");

  NodeFS.writeFileSync(
    NodePath.join(fixtureDir, "monitors.json"),
    JSON.stringify([
      {
        id: 0,
        name: "eDP-1",
        width: 3072,
        height: 1920,
        x: 0,
        y: 0,
        scale: 2,
        focused: true,
        dpmsStatus: true,
      },
    ]),
  );
  const layoutFile = NodePath.join(fixtureDir, "layout.txt");
  NodeFS.writeFileSync(layoutFile, "gb");
  const setLayout = (layout: string) => {
    NodeFS.writeFileSync(layoutFile, layout);
  };
  const lockedFile = NodePath.join(fixtureDir, "locked");
  const setLocked = (locked: boolean) => {
    NodeFS.writeFileSync(lockedFile, locked ? "true" : "false");
  };
  setLocked(false);
  const active = NodePath.join(fixtureDir, "activewindow.json");
  const setActiveWindow = (window: Record<string, unknown>) => {
    NodeFS.writeFileSync(active, JSON.stringify(window));
  };
  setActiveWindow({
    address: "0xabc",
    title: "Terminal",
    class: "alacritty",
    workspace: { id: 2, name: "2" },
    monitor: 0,
  });
  const clients = NodePath.join(fixtureDir, "clients.json");
  const setClients = (list: ReadonlyArray<Record<string, unknown>>) => {
    NodeFS.writeFileSync(clients, JSON.stringify(list));
  };
  // The terminal fills the screen; a test that wants Brave under a point adds
  // its own client.
  setClients([
    {
      address: "0xabc",
      title: "Terminal",
      class: "alacritty",
      at: [0, 0],
      size: [1536, 960],
      mapped: true,
      hidden: false,
      workspace: { id: 2, name: "2" },
    },
  ]);

  script(
    NodePath.join(binDir, "hyprctl"),
    `case "$*" in
  *"monitors -j"*) cat "${Path(fixtureDir, "monitors.json")}" ;;
  *"activewindow -j"*) cat "${Path(fixtureDir, "activewindow.json")}" ;;
  *"clients -j"*) cat "${Path(fixtureDir, "clients.json")}" ;;
  *"getoption"*) printf '{"option":"input:kb_layout","str":"%s"}' "$(cat "${Path(fixtureDir, "layout.txt")}")" ;;
  *"cursorpos"*) echo "100, 200" ;;
  *"instances -j"*) echo '[]' ;;
  *"version"*) echo '{"version":"0.56.2"}' ;;
  *) echo "ok" ;;
esac`,
  );
  script(
    NodePath.join(binDir, "grim"),
    `out=""
for arg in "$@"; do out="$arg"; done
printf '%s' '${JPEG_B64}' | base64 -d > "$out"
echo grim >> "${log}"`,
  );
  script(
    NodePath.join(binDir, "omarchy-shell"),
    `case "$*" in
  *isLocked*) cat "${Path(fixtureDir, "locked")}" ;;
  *) echo "" ;;
esac`,
  );
  script(
    NodePath.join(binDir, "notify-send"),
    `echo "$@" >> "${notifyLog}"
echo 42`,
  );
  script(NodePath.join(binDir, "gdbus"), `echo "()"`);
  script(NodePath.join(binDir, "magick"), `exit 0`);

  const helperPath = NodePath.join(workDir, "fake-pbdesk-wl");
  if (binary === undefined) {
    NodeFS.writeFileSync(
      helperPath,
      `#!/bin/sh
echo "ready layout=$1 pid=$$"
while IFS= read -r line; do
  echo "$line" >> "${helperLog}"
  id=\${line%% *}
  case "$line" in
    *" crash"*) exit 1 ;;
    *" key Right down"*) echo "err $id no such key" ;;
    *) echo "ok $id 10" ;;
  esac
done
`,
      "utf8",
    );
    NodeFS.chmodSync(helperPath, 0o755);
  }

  return {
    binDir,
    log,
    helperLog,
    notifyLog,
    workDir,
    helperPath,
    setActiveWindow,
    setClients,
    setLayout,
    setLocked,
    helperCommands: () =>
      NodeFS.readFileSync(helperLog, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^\d+ /, "")),
  };
}

const Path = (dir: string, file: string): string => NodePath.join(dir, file);
