import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { makePlaywrightDriver } from "./driver.ts";

const BRAVE = process.env.HBOTS_TEST_BRAVE;

interface RawCdp {
  readonly send: (method: string, params?: object, sessionId?: string) => Promise<any>;
  readonly events: string[];
  readonly close: () => void;
}

const openRawCdp = async (url: string): Promise<RawCdp> => {
  const socket = new WebSocket(url);
  await new Promise<void>((ready) => {
    socket.onopen = () => ready();
  });
  let next = 0;
  const pending = new Map<number, (message: any) => void>();
  const events: string[] = [];
  socket.onmessage = (message) => {
    const parsed = JSON.parse(String(message.data));
    if (typeof parsed.id === "number") pending.get(parsed.id)?.(parsed);
    else if (typeof parsed.method === "string") events.push(parsed.method);
  };
  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => socket.close(),
  };
};

describe.skipIf(BRAVE === undefined)("shared attach against a throwaway headless Brave", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-shared-live-"));
  const profile = NodePath.join(root, "profile");
  const home = NodePath.join(root, "home");
  const downloads = NodePath.join(home, "Downloads");
  let pid: number | null = null;

  afterAll(() => {
    if (pid !== null) {
      try {
        process.kill(pid);
      } catch {
        pid = null;
      }
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("detaching closes the bot page only; his browser, his page, his dialog and his downloads stay", async () => {
    NodeFS.mkdirSync(NodePath.join(profile, "Default"), { recursive: true });
    NodeFS.mkdirSync(downloads, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(profile, "Default", "Preferences"),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
    );
    const child = NodeChildProcess.spawn(
      BRAVE!,
      [
        "--headless=new",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "about:blank",
      ],
      {
        stdio: "ignore",
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: NodePath.join(home, ".config") },
      },
    );
    pid = child.pid ?? null;
    expect(pid).not.toBeNull();
    const portFile = NodePath.join(profile, "DevToolsActivePort");
    for (let tries = 0; tries < 100 && !NodeFS.existsSync(portFile); tries++) {
      await NodeTimersPromises.setTimeout(100);
    }
    const [port, browserPath] = NodeFS.readFileSync(portFile, "utf8").trim().split("\n");

    const files = NodeHttp.createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="owner-file.bin"',
      });
      outgoing.end("owner-bytes");
    });
    await new Promise<void>((ready) => files.listen(0, "127.0.0.1", ready));
    const filesPort = (files.address() as NodeNet.AddressInfo).port;

    const owner = await openRawCdp(`ws://127.0.0.1:${port}${browserPath}`);
    const created = await owner.send("Target.createTarget", { url: "about:blank" });
    const ownerTarget: string = created.result.targetId;
    const attachedTarget = await owner.send("Target.attachToTarget", {
      targetId: ownerTarget,
      flatten: true,
    });
    const ownerSession: string = attachedTarget.result.sessionId;
    await owner.send("Page.enable", {}, ownerSession);
    const targetIds = async () =>
      ((await owner.send("Target.getTargets")).result.targetInfos as Array<any>)
        .filter((info) => info.type === "page")
        .map((info) => info.targetId as string);
    const before = await targetIds();

    const handle = await makePlaywrightDriver().attach({ userDataDir: profile });
    const botPage = await handle.newPage();
    expect(botPage).toBeDefined();
    const duringIds = await targetIds();
    const botTarget = duringIds.find((id) => !before.includes(id));
    expect(botTarget).toBeDefined();

    owner.events.length = 0;
    await owner.send(
      "Runtime.evaluate",
      { expression: "setTimeout(() => alert('his dialog'), 300); 1" },
      ownerSession,
    );
    await NodeTimersPromises.setTimeout(2_000);
    expect(owner.events).toContain("Page.javascriptDialogOpening");
    expect(owner.events).not.toContain("Page.javascriptDialogClosed");
    await owner.send("Page.handleJavaScriptDialog", { accept: true }, ownerSession);

    await owner.send(
      "Page.navigate",
      { url: `http://127.0.0.1:${filesPort}/owner-file` },
      ownerSession,
    );
    await NodeTimersPromises.setTimeout(2_000);
    expect(NodeFS.readdirSync(downloads)).toContain("owner-file.bin");

    await handle.detach();
    await NodeTimersPromises.setTimeout(500);

    expect(() => process.kill(pid!, 0)).not.toThrow();
    const after = await targetIds();
    expect(after).toContain(ownerTarget);
    expect(after).not.toContain(botTarget);

    owner.close();
    files.close();
  });
});
