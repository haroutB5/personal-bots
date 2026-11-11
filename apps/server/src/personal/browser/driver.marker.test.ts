import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makePlaywrightDriver } from "./driver.ts";

const fake = vi.hoisted(() => {
  const context = {
    pages: vi.fn(() => []),
    newPage: vi.fn(),
    newCDPSession: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    close: vi.fn(),
  };
  return { context, launch: vi.fn(async () => context) };
});

vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext: fake.launch } }));

const folders: string[] = [];
const freshFolder = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-marker-"));
  folders.push(folder);
  return folder;
};

beforeEach(() => {
  fake.launch.mockClear();
});

afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const launchIn = (userDataDir: string) =>
  makePlaywrightDriver({ resolveExecutable: () => "/opt/brave-bin/brave" }).launch({
    userDataDir,
    downloadsDir: NodePath.join(userDataDir, "..", "downloads"),
    headless: true,
    executablePath: undefined,
    onDownloadSaved: () => {},
  });

describe("owned launch and an imported profile", () => {
  it("refuses a folder holding hbots-import.json before any browser process starts", async () => {
    const folder = freshFolder();
    NodeFS.writeFileSync(NodePath.join(folder, "hbots-import.json"), "{}\n");

    const failure = await launchIn(folder).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `This browser folder was imported from a real browser and must not be launched by hbots: ${folder} holds hbots-import.json. Use the shared browser setting, or point hbots at a different folder.`,
    );
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("launches an ordinary folder", async () => {
    const folder = freshFolder();

    await launchIn(folder);

    expect(fake.launch).toHaveBeenCalledTimes(1);
    expect(fake.launch.mock.calls[0]).toEqual([
      folder,
      expect.objectContaining({ headless: true }),
    ]);
  });
});
