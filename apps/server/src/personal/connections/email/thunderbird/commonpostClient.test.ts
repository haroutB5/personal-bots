import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ConnectionVendorError } from "../../adapters.ts";
import { CommonpostClient, layer, type CommonpostConfig } from "./commonpostClient.ts";
import { COMMONPOST_TOOLS_FINGERPRINT } from "./pins.ts";
import { THUNDERBIRD_ADDON_LINE, THUNDERBIRD_CLOSED_LINE } from "./status.ts";
import * as ThunderbirdProcess from "./thunderbirdProcess.ts";

const FIXTURES = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fixtures",
);
const FAKE = NodePath.join(FIXTURES, "fakeBridge.cjs");
const sha = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

const withHome = <A>(mode: string, run: (home: string) => Promise<A>): Promise<A> => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tb-client-"));
  NodeFS.writeFileSync(NodePath.join(home, "mode"), mode);
  return run(home).finally(() => NodeFS.rmSync(home, { recursive: true, force: true }));
};

const configFor = (home: string, patch: Partial<CommonpostConfig> = {}): CommonpostConfig => ({
  nodePath: process.execPath,
  bridgePath: FAKE,
  expectedBridgeSha256: sha(FAKE),
  expectedToolsFingerprint: COMMONPOST_TOOLS_FINGERPRINT,
  tmpDir: "/tmp",
  home,
  ...patch,
});

const withClient = <A, E>(use: (client: CommonpostClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const client = yield* CommonpostClient;
    return yield* use(client);
  });

const run = <A, E>(
  config: CommonpostConfig,
  running: boolean,
  effect: Effect.Effect<A, E, CommonpostClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer(config).pipe(Layer.provide(ThunderbirdProcess.layerOf(running)))),
    ),
  );

const status = (config: CommonpostConfig, running = true) =>
  run(
    config,
    running,
    withClient((client) => client.status()),
  );

describe("CommonpostClient against a fake bridge", () => {
  it("is ready with the mail accounts and drops Local Folders", () =>
    withHome("ready", async (home) => {
      const result = await status(configFor(home));
      expect(result).toEqual({
        _tag: "ready",
        accounts: [
          {
            accountId: "account1",
            address: "harout@gmail.com",
            vendor: "gmail",
            serverType: "imap",
          },
          { accountId: "account2", address: "h@live.com", vendor: "outlook", serverType: "imap" },
          { accountId: "account3", address: "h@outlook.com", vendor: "outlook", serverType: "ews" },
        ],
      });
    }));

  it("passes the hbots profile and a minimal environment to the bridge", () =>
    withHome("ready", async (home) => {
      process.env["HBOTS_SECRET"] = "must-not-reach-the-bridge";
      try {
        await status(configFor(home));
      } finally {
        delete process.env["HBOTS_SECRET"];
      }
      const first = JSON.parse(
        NodeFS.readFileSync(NodePath.join(home, "seen.jsonl"), "utf8").split("\n")[0] ?? "{}",
      );
      expect(first).toEqual({ profile: "hbots", tmp: "/tmp", leaked: null });
    }));

  it("is closed when tool calls fail to reach Thunderbird and no process runs", () =>
    withHome("closed", async (home) => {
      expect(await status(configFor(home), false)).toEqual({ _tag: "closed" });
    }));

  it("is addon-missing when Thunderbird runs but the add-on does not answer", () =>
    withHome("closed", async (home) => {
      expect(await status(configFor(home), true)).toEqual({ _tag: "addon-missing" });
    }));

  it("stops asking once the first call showed Thunderbird is closed", () =>
    withHome("closed", async (home) => {
      await status(configFor(home), false);
      const methods = NodeFS.readFileSync(NodePath.join(home, "seen.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.includes('"method"'))
        .map((line) => JSON.parse(line).method);
      expect(methods).toEqual(["initialize", "tools/call"]);
    }));

  it("is unsupported when the bridge file is not the pinned one", () =>
    withHome("ready", async (home) => {
      const result = await status(configFor(home, { expectedBridgeSha256: "0".repeat(64) }));
      expect(result._tag).toBe("unsupported");
    }));

  it("is unsupported when the bridge file is missing", () =>
    withHome("ready", async (home) => {
      const result = await status(configFor(home, { bridgePath: NodePath.join(home, "none.cjs") }));
      expect(result).toMatchObject({ _tag: "unsupported" });
    }));

  it("is unsupported when the add-on's argument schemas differ from the reviewed ones", () =>
    withHome("drift", async (home) => {
      expect(await status(configFor(home))).toMatchObject({
        _tag: "unsupported",
        reason: expect.stringContaining("differ"),
      });
    }));

  it("is unsupported with the bridge's own words when the add-on is too old", () =>
    withHome("notice", async (home) => {
      expect(await status(configFor(home))).toMatchObject({
        _tag: "unsupported",
        reason: expect.stringContaining("version 0.9.0"),
      });
    }));

  it("is unsupported rather than hanging when the bridge dies at once", () =>
    withHome("exit", async (home) => {
      expect(await status(configFor(home))).toMatchObject({ _tag: "unsupported" });
    }));

  it("returns a tool's parsed reply and sends exactly the named tool and arguments", () =>
    withHome("ready", async (home) => {
      const value = await run(
        configFor(home),
        true,
        withClient((client) => client.call("searchMessages", { query: "invoice", maxResults: 5 })),
      );
      expect(value).toEqual({
        echoed: "searchMessages",
        arguments: { query: "invoice", maxResults: 5 },
      });
    }));

  it("fails a call with the not running line and the unavailable flag when Thunderbird is closed", () =>
    withHome("closed", async (home) => {
      const error = await run(
        configFor(home),
        false,
        withClient((client) => client.call("listAccounts", {})).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(ConnectionVendorError);
      expect(error.detail).toBe(THUNDERBIRD_CLOSED_LINE);
      expect(error.unavailable).toBe(true);
    }));

  it("says the add-on is not answering when Thunderbird runs", () =>
    withHome("closed", async (home) => {
      const error = await run(
        configFor(home),
        true,
        withClient((client) => client.call("listAccounts", {})).pipe(Effect.flip),
      );
      expect(error.detail).toBe(THUNDERBIRD_ADDON_LINE);
    }));

  it("keeps the add-on's own refusal text for any other tool error", () =>
    withHome("from-mismatch", async (home) => {
      const error = await run(
        configFor(home),
        true,
        withClient((client) => client.call("saveDraft", { from: "x@y.com" })).pipe(Effect.flip),
      );
      expect(error.detail).toBe("from identity does not match any identity");
      expect(error.unavailable).toBeUndefined();
    }));

  it("refuses to spawn a bridge whose hash is not the pinned one", () =>
    withHome("ready", async (home) => {
      const error = await run(
        configFor(home, { expectedBridgeSha256: "1".repeat(64) }),
        true,
        withClient((client) => client.call("listAccounts", {})).pipe(Effect.flip),
      );
      expect(error.detail).toContain("not the version");
      expect(NodeFS.existsSync(NodePath.join(home, "seen.jsonl"))).toBe(false);
    }));

  it("fails a call the bridge never answers once its time is up", () =>
    withHome("hang", async (home) => {
      const error = await run(
        configFor(home, { timeouts: { callMs: 300, composeMs: 300, listMs: 300 } }),
        true,
        withClient((client) => client.call("getMessage", {})).pipe(Effect.flip),
      );
      expect(error.detail).toContain("did not answer");
    }));

  it("gives a draft its own, longer time", () =>
    withHome("hang", async (home) => {
      const error = await run(
        configFor(home, { timeouts: { callMs: 100, composeMs: 600, listMs: 100 } }),
        true,
        withClient((client) => {
          const startedAt = Date.now();
          return client.call("saveDraft", {}).pipe(
            Effect.flip,
            Effect.map((failure) => ({ failure, took: Date.now() - startedAt })),
          );
        }),
      );
      expect(error.failure.detail).toContain("did not answer");
      expect(error.took).toBeGreaterThanOrEqual(550);
    }));
});
