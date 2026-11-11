import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { SharedAttachError, sharedAttachSentence } from "./browserBackend.ts";
import { resolveSharedEndpoint } from "./sharedBrowser.ts";

const folders: string[] = [];
const servers: NodeHttp.Server[] = [];

const freshFolder = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-shared-"));
  folders.push(folder);
  return folder;
};

afterEach(async () => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

const serve = async (reply: (url: string) => { status: number; body: string }) => {
  const server = NodeHttp.createServer((incoming, outgoing) => {
    const { status, body } = reply(incoming.url ?? "");
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(body);
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as NodeNet.AddressInfo).port;
};

const unusedPort = async () => {
  const server = NodeHttp.createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as NodeNet.AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
};

const writePortFile = (folder: string, contents: string) =>
  NodeFS.writeFileSync(NodePath.join(folder, "DevToolsActivePort"), contents);

const reasonOf = async (folder: string) => {
  const failure = await resolveSharedEndpoint(folder).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(SharedAttachError);
  return failure as SharedAttachError;
};

const BROWSER_PATH = "/devtools/browser/0b9d6a54-61a7-4b0f-9b3e-2d3cbb3f5d11";
const versionBody = (port: number, path = BROWSER_PATH) =>
  JSON.stringify({
    Browser: "Chrome/156.0.0.0",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}`,
  });

describe("attaching to the shared browser", () => {
  it("reads the port file and returns the browser websocket on loopback", async () => {
    const folder = freshFolder();
    const port = await serve(() => ({ status: 200, body: versionBody(0) }));
    writePortFile(folder, `${port}\n${BROWSER_PATH}\n`);

    await expect(resolveSharedEndpoint(folder)).resolves.toEqual({
      wsEndpoint: `ws://127.0.0.1:${port}${BROWSER_PATH}`,
    });
  });

  it("says Brave is not open when the folder has no port file", async () => {
    const error = await reasonOf(freshFolder());

    expect(error.reason).toBe("brave-not-running");
    expect(error.message).toBe("Brave is not open on the laptop. Ask Harout to open it.");
  });

  it("says the port file is stale when nothing answers on its port", async () => {
    const folder = freshFolder();
    writePortFile(folder, `${await unusedPort()}\n${BROWSER_PATH}\n`);

    const error = await reasonOf(folder);

    expect(error.reason).toBe("port-file-stale");
    expect(error.message).toBe(sharedAttachSentence("port-file-stale"));
  });

  it("treats an unreadable port file as stale", async () => {
    const folder = freshFolder();
    writePortFile(folder, "not-a-port\n");

    expect((await reasonOf(folder)).reason).toBe("port-file-stale");
  });

  it("says it is the wrong browser when the port answers with something else", async () => {
    const folder = freshFolder();
    const port = await serve(() => ({ status: 200, body: "<html>router login</html>" }));
    writePortFile(folder, `${port}\n${BROWSER_PATH}\n`);

    const error = await reasonOf(folder);

    expect(error.reason).toBe("wrong-browser");
    expect(error.message).toBe(sharedAttachSentence("wrong-browser"));
  });

  it("says it is the wrong browser when the answer names a different browser id", async () => {
    const folder = freshFolder();
    const port = await serve(() => ({
      status: 200,
      body: versionBody(0, "/devtools/browser/another-instance"),
    }));
    writePortFile(folder, `${port}\n${BROWSER_PATH}\n`);

    expect((await reasonOf(folder)).reason).toBe("wrong-browser");
  });

  it("says it is the wrong browser when it does not call itself Chrome", async () => {
    const folder = freshFolder();
    const port = await serve(() => ({
      status: 200,
      body: JSON.stringify({
        Browser: "Firefox/140.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:0${BROWSER_PATH}`,
      }),
    }));
    writePortFile(folder, `${port}\n${BROWSER_PATH}\n`);

    expect((await reasonOf(folder)).reason).toBe("wrong-browser");
  });

  it("gives each failure its own plain sentence", () => {
    expect(sharedAttachSentence("brave-not-running")).toBe(
      "Brave is not open on the laptop. Ask Harout to open it.",
    );
    expect(sharedAttachSentence("port-file-stale")).toBe(
      "Brave's debugging port file is out of date and nothing answers on it. Ask Harout to restart Brave.",
    );
    expect(sharedAttachSentence("wrong-browser")).toBe(
      "Something other than Brave answers on Brave's debugging port. Ask Harout to check the shared browser setting.",
    );
  });
});
