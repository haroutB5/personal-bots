import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

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
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await Promise.resolve(cleanup()).catch(() => undefined);
    }
  });

  const startBrave = async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-shared-live-"));
    const profile = NodePath.join(root, "profile");
    const home = NodePath.join(root, "home");
    const downloads = NodePath.join(home, "Downloads");
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
    const pid = child.pid ?? null;
    cleanups.push(async () => {
      if (pid !== null) {
        try {
          process.kill(pid);
          for (let tries = 0; tries < 50; tries++) {
            process.kill(pid, 0);
            await NodeTimersPromises.setTimeout(100);
          }
        } catch {
          // The process is gone.
        }
      }
      NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    expect(pid).not.toBeNull();
    const portFile = NodePath.join(profile, "DevToolsActivePort");
    for (let tries = 0; tries < 100 && !NodeFS.existsSync(portFile); tries++) {
      await NodeTimersPromises.setTimeout(100);
    }
    const [port, browserPath] = NodeFS.readFileSync(portFile, "utf8").trim().split("\n");
    return { pid: pid!, profile, downloads, port: port!, browserPath: browserPath! };
  };

  const openOwner = async (brave: Awaited<ReturnType<typeof startBrave>>) => {
    const owner = await openRawCdp(`ws://127.0.0.1:${brave.port}${brave.browserPath}`);
    cleanups.push(() => owner.close());
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
    const read = async (expression: string): Promise<any> =>
      (
        await owner.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          ownerSession,
        )
      ).result.result.value;
    return { owner, ownerTarget, ownerSession, targetIds, read };
  };

  const serveBotPages = async () => {
    const server = NodeHttp.createServer((incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "text/html" });
      outgoing.end(
        incoming.url === "/popup"
          ? "<title>popup</title><button id=p>popup</button>"
          : "<title>bot</title><button id=b>go</button><a id=a target=_blank href=/popup>pop</a>",
      );
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    cleanups.push(() => void server.close());
    return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  };

  const startHarness = async () => {
    const brave = await startBrave();
    const his = await openOwner(brave);
    const base = await serveBotPages();
    const before = await his.targetIds();
    const handle = await makePlaywrightDriver().attach({ userDataDir: brave.profile });
    cleanups.push(() => handle.detach());
    const openBotPage = async () => {
      const page = await handle.newPage();
      const botTarget = (await his.targetIds()).find((id) => !before.includes(id));
      expect(botTarget).toBeDefined();
      return { page, botTarget: botTarget! };
    };
    const showHisTab = async () => {
      await his.owner.send("Target.activateTarget", { targetId: his.ownerTarget });
      await NodeTimersPromises.setTimeout(400);
    };
    const hisState = () => his.read("document.visibilityState + '/' + document.hasFocus()");
    const watchHisTab = () => {
      const bad: string[] = [];
      let samples = 0;
      let running = true;
      const loop = (async () => {
        while (running) {
          const state = String(await hisState());
          samples++;
          if (state !== "visible/true") bad.push(state);
          await NodeTimersPromises.setTimeout(25);
        }
      })();
      return async () => {
        running = false;
        await loop;
        return { bad, samples };
      };
    };
    const centrePixel = (png: Uint8Array) =>
      his.read(`new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          resolve([...context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data].slice(0, 3).join(','));
        };
        image.src = 'data:image/png;base64,${Buffer.from(png).toString("base64")}';
      })`);
    return {
      brave,
      his,
      base,
      handle,
      openBotPage,
      showHisTab,
      hisState,
      watchHisTab,
      centrePixel,
    };
  };

  const PAINT_FRAMES_IN_ONE_SECOND = `new Promise((resolve) => {
    let frames = 0;
    const end = performance.now() + 1000;
    const tick = () => {
      document.body.style.background = 'hsl(' + ((frames * 7) % 360) + ' 80% 50%)';
      frames++;
      if (performance.now() < end) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  })`;

  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("detaching closes the bot page only; his browser, his page, his dialog and his downloads stay", async () => {
    const brave = await startBrave();
    const files = NodeHttp.createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="owner-file.bin"',
      });
      outgoing.end("owner-bytes");
    });
    await new Promise<void>((ready) => files.listen(0, "127.0.0.1", ready));
    cleanups.push(() => void files.close());
    const filesPort = (files.address() as NodeNet.AddressInfo).port;

    const { owner, ownerTarget, ownerSession, targetIds } = await openOwner(brave);
    const before = await targetIds();

    const handle = await makePlaywrightDriver().attach({ userDataDir: brave.profile });
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
    expect(NodeFS.readdirSync(brave.downloads)).toContain("owner-file.bin");

    await handle.detach();
    await NodeTimersPromises.setTimeout(500);

    expect(() => process.kill(brave.pid, 0)).not.toThrow();
    const after = await targetIds();
    expect(after).toContain(ownerTarget);
    expect(after).not.toContain(botTarget);
  });

  it("a bot tab stays clickable and screenshottable while his tab is in front", async () => {
    const { base, openBotPage, showHisTab } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();

    const clickStarted = Date.now();
    await page.clickLocator("#b", 3_000);
    const clickMs = Date.now() - clickStarted;

    const viewport = await page.viewportSize();
    const shotMs: number[] = [];
    for (let shot = 0; shot < 6; shot++) {
      const started = Date.now();
      const png = Buffer.from(await page.screenshotPng());
      shotMs.push(Date.now() - started);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(viewport);
    }
    console.info(`h1 timings ${JSON.stringify({ clickMs, shotMs })}`);
    expect(Math.max(...shotMs)).toBeLessThan(2_000);
    expect(await page.evaluate("document.visibilityState")).toBe("visible");
  });

  it("opening a bot tab leaves his tab in front and focused", async () => {
    const { openBotPage, hisState } = await startHarness();
    expect(await hisState()).toBe("visible/true");
    await openBotPage();
    await NodeTimersPromises.setTimeout(400);
    expect(await hisState()).toBe("visible/true");
  });

  it("his tab gets no focus override", async () => {
    const { his, openBotPage, hisState } = await startHarness();
    const { botTarget } = await openBotPage();
    await his.owner.send("Target.activateTarget", { targetId: botTarget });
    await NodeTimersPromises.setTimeout(400);
    expect((await hisState()).split("/")[0]).toBe("hidden");
  });

  it("a popup the bot opens works behind his tab", async () => {
    const { base, handle, openBotPage, showHisTab } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await page.clickLocator("#a", 3_000);
    for (let tries = 0; tries < 50 && handle.pages().length < 2; tries++) {
      await NodeTimersPromises.setTimeout(100);
    }
    await showHisTab();
    const popup = handle.pages().find((candidate) => candidate.url().endsWith("/popup"));
    expect(popup).toBeDefined();
    await popup!.clickLocator("#p", 3_000);
  });

  it("a screenshot shows what the page drew last", async () => {
    const { base, openBotPage, showHisTab, centrePixel } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    for (const colour of ["204,0,0", "0,153,0", "0,0,204"]) {
      await page.evaluate(`document.documentElement.style.background = 'rgb(${colour})'`);
      expect(await centrePixel(await page.screenshotPng())).toBe(colour);
    }
  });

  it("a painting bot tab behind his tab keeps full frame rate", async () => {
    const { base, openBotPage, showHisTab, watchHisTab } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    const stopWatching = watchHisTab();
    const frames = Number(await page.evaluate(PAINT_FRAMES_IN_ONE_SECOND));
    const watched = await stopWatching();
    console.info(`h1r2 paint ${JSON.stringify({ frames, samples: watched.samples })}`);
    expect(frames).toBeGreaterThanOrEqual(30);
    expect(watched.bad).toEqual([]);
  });

  it("steady-state clicks behind his tab finish inside 1000 ms", async () => {
    const { base, openBotPage, showHisTab, watchHisTab } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    const stopWatching = watchHisTab();
    const clickMs: number[] = [];
    for (let round = 0; round < 5; round++) {
      await NodeTimersPromises.setTimeout(1_500);
      const started = Date.now();
      await page.clickLocator("#b", 1_000);
      clickMs.push(Date.now() - started);
    }
    const watched = await stopWatching();
    console.info(`h1r2 clicks ${JSON.stringify({ clickMs, samples: watched.samples })}`);
    expect(watched.bad).toEqual([]);
  });

  it("an idle screenshot shows the new colour fast", async () => {
    const { base, openBotPage, showHisTab, watchHisTab, centrePixel } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    const stopWatching = watchHisTab();
    await page.evaluate(PAINT_FRAMES_IN_ONE_SECOND);
    const colours = ["204,0,0", "0,153,0", "0,0,204", "204,204,0", "0,204,204", "102,0,102"];
    const shotMs: number[] = [];
    const stale: string[] = [];
    for (const colour of colours) {
      await NodeTimersPromises.setTimeout(1_500);
      await page.evaluate(
        `document.body.style.background = document.documentElement.style.background = 'rgb(${colour})'`,
      );
      const started = Date.now();
      const png = await page.screenshotPng();
      shotMs.push(Date.now() - started);
      const seen = await centrePixel(png);
      if (seen !== colour) stale.push(`${seen} instead of ${colour}`);
    }
    const watched = await stopWatching();
    console.info(`h1r2 shots ${JSON.stringify({ shotMs, stale, samples: watched.samples })}`);
    expect(stale).toEqual([]);
    expect(Math.max(...shotMs)).toBeLessThan(400);
    expect(watched.bad).toEqual([]);
  });

  it("the pump survives the viewer and a cross-site navigation", async () => {
    const { base, openBotPage, showHisTab, watchHisTab } = await startHarness();
    const { page } = await openBotPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    const stopWatching = watchHisTab();
    const stopViewer = await page.startScreencast(() => {});
    await page.setScreencastProfile!("moving");
    await page.setScreencastProfile!("sharp");
    await stopViewer();
    const afterViewer = Number(await page.evaluate(PAINT_FRAMES_IN_ONE_SECOND));
    await page.goto(`${base.replace("127.0.0.1", "localhost")}/`, {
      waitUntil: "load",
      timeoutMs: 5_000,
    });
    const afterNavigation = Number(await page.evaluate(PAINT_FRAMES_IN_ONE_SECOND));
    await page.reload();
    await NodeTimersPromises.setTimeout(500);
    const afterReload = Number(await page.evaluate(PAINT_FRAMES_IN_ONE_SECOND));
    const watched = await stopWatching();
    console.info(
      `h1r2 survive ${JSON.stringify({ afterViewer, afterNavigation, afterReload, samples: watched.samples })}`,
    );
    expect(afterViewer).toBeGreaterThanOrEqual(30);
    expect(afterNavigation).toBeGreaterThanOrEqual(30);
    expect(afterReload).toBeGreaterThanOrEqual(30);
    expect(watched.bad).toEqual([]);
  });

  it("closing a bot tab ends its pump and a reopened tab pumps again", async () => {
    const { base, his, handle, openBotPage, showHisTab, watchHisTab } = await startHarness();
    const first = await openBotPage();
    await first.page.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    await showHisTab();
    const stopWatching = watchHisTab();
    await first.page.close();
    for (let tries = 0; tries < 50 && (await his.targetIds()).includes(first.botTarget); tries++) {
      await NodeTimersPromises.setTimeout(100);
    }
    const remaining = await his.targetIds();
    expect(remaining).toContain(his.ownerTarget);
    expect(remaining).not.toContain(first.botTarget);
    expect(handle.pages()).toHaveLength(0);
    const second = await handle.newPage();
    await second.goto(`${base}/`, { waitUntil: "load", timeoutMs: 5_000 });
    const frames = Number(await second.evaluate(PAINT_FRAMES_IN_ONE_SECOND));
    const watched = await stopWatching();
    console.info(`h1r2 reopen ${JSON.stringify({ frames, samples: watched.samples })}`);
    expect(frames).toBeGreaterThanOrEqual(30);
    expect(watched.bad).toEqual([]);
  });
});
