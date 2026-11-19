import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PersonalConnection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PersonalConnectionService } from "../../service.ts";
import { CommonpostClient } from "./commonpostClient.ts";
import { renderUserJs } from "./profile.ts";
import { makeThunderbirdSetup, ThunderbirdSetup } from "./setup.ts";
import type { ThunderbirdAccount, ThunderbirdStatus } from "./status.ts";
import { ThunderbirdProcess } from "./thunderbirdProcess.ts";

const GMAIL: ThunderbirdAccount = {
  accountId: "account1",
  address: "harout@gmail.com",
  vendor: "gmail",
  serverType: "imap",
};
const OUTLOOK: ThunderbirdAccount = {
  accountId: "account2",
  address: "harout@outlook.com",
  vendor: "outlook",
  serverType: "ews",
};

const PREFS = [
  'user_pref("mail.account.account1.server", "server1");',
  'user_pref("mail.account.account2.server", "server2");',
  "",
].join("\n");

interface Harness {
  readonly home: string;
  readonly userJs: string;
  readonly events: Array<string>;
  readonly setup: (status: ThunderbirdStatus) => Promise<ThunderbirdSetup["Service"]>;
}

const withHarness = async (run: (h: Harness) => Promise<void>) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tb-setup-"));
  const profile = NodePath.join(home, ".thunderbird", "profile.test");
  NodeFS.mkdirSync(profile, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, ".thunderbird", "profiles.ini"),
    "[Profile0]\nName=hbots-mail\nIsRelative=1\nPath=profile.test\n",
  );
  NodeFS.writeFileSync(NodePath.join(profile, "prefs.js"), PREFS);
  NodeFS.writeFileSync(NodePath.join(profile, "user.js"), renderUserJs());
  const events: Array<string> = [];
  const userJsPath = NodePath.join(profile, "user.js");
  const setup = (status: ThunderbirdStatus) => {
    const layer = Layer.mergeAll(
      Layer.succeed(CommonpostClient, {
        call: () => Effect.die("unused"),
        status: () => Effect.succeed(status),
      }),
      Layer.succeed(ThunderbirdProcess, {
        running: () => Effect.succeed(status._tag === "ready"),
        launch: () =>
          Effect.sync(() => {
            events.push(`launch:${NodeFS.readFileSync(userJsPath, "utf8").length}`);
          }),
        terminate: () =>
          Effect.sync(() => {
            events.push(`terminate:${NodeFS.readFileSync(userJsPath, "utf8").length}`);
          }),
      }),
      Layer.mock(PersonalConnectionService)({
        connectLocalMailbox: (input) =>
          Effect.sync(() => {
            events.push(`row:${input.vendorId}:${input.address}`);
            return {} as PersonalConnection;
          }),
      }),
    );
    return Effect.runPromise(
      makeThunderbirdSetup({ home, profileName: "hbots-mail" }).pipe(Effect.provide(layer)),
    );
  };
  try {
    await run({
      home,
      get userJs() {
        return NodeFS.readFileSync(userJsPath, "utf8");
      },
      events,
      setup,
    });
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

describe("ThunderbirdSetup.useAccounts", () => {
  it("writes the allowlist and offline copies, restarts around the write, then adds the rows", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "ready", accounts: [GMAIL, OUTLOOK] });
      const before = h.userJs.length;
      const result = await Effect.runPromise(setup.useAccounts({ accountIds: ["account1"] }));
      expect(result).toEqual({ changed: true, problem: null });
      expect(h.userJs).toBe(
        renderUserJs({ allowedAccounts: ["account1"], offlineServers: ["server1"] }),
      );
      expect(h.events).toEqual([
        `terminate:${before}`,
        `launch:${h.userJs.length}`,
        "row:gmail:harout@gmail.com",
      ]);
    });
  });

  it("changes nothing on a second run and does not restart Thunderbird", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "ready", accounts: [GMAIL] });
      await Effect.runPromise(setup.useAccounts({ accountIds: ["account1"] }));
      const first = h.userJs;
      h.events.length = 0;
      const again = await Effect.runPromise(setup.useAccounts({ accountIds: ["account1"] }));
      expect(again).toEqual({ changed: false, problem: null });
      expect(h.userJs).toBe(first);
      expect(h.events).toEqual(["row:gmail:harout@gmail.com"]);
    });
  });

  it("refuses an account that is not IMAP and writes nothing", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "ready", accounts: [GMAIL, OUTLOOK] });
      const before = h.userJs;
      const result = await Effect.runPromise(
        setup.useAccounts({ accountIds: ["account1", "account2"] }),
      );
      expect(result.changed).toBe(false);
      expect(result.problem).toContain("harout@outlook.com is not an IMAP account");
      expect(h.userJs).toBe(before);
      expect(h.events).toEqual([]);
    });
  });

  it("refuses an id Thunderbird does not list", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "ready", accounts: [GMAIL] });
      const result = await Effect.runPromise(setup.useAccounts({ accountIds: ["account9"] }));
      expect(result.problem).toContain("no longer lists");
      expect(h.events).toEqual([]);
    });
  });

  it("refuses while Thunderbird is closed", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "closed" });
      const result = await Effect.runPromise(setup.useAccounts({ accountIds: ["account1"] }));
      expect(result.problem).toContain("has to be open");
      expect(h.events).toEqual([]);
    });
  });
});

describe("ThunderbirdSetup.status and start", () => {
  it("reports the allowlist as unconfirmed until it is written, with the profile size", async () => {
    await withHarness(async (h) => {
      const setup = await h.setup({ _tag: "ready", accounts: [GMAIL] });
      const first = await Effect.runPromise(setup.status());
      expect(first.accountsConfirmed).toBe(false);
      expect(first.profileSizeBytes).toBeGreaterThan(0);
      await Effect.runPromise(setup.useAccounts({ accountIds: ["account1"] }));
      expect((await Effect.runPromise(setup.status())).accountsConfirmed).toBe(true);
    });
  });

  it("starts Thunderbird only when it is closed", async () => {
    await withHarness(async (h) => {
      const closed = await h.setup({ _tag: "closed" });
      expect(await Effect.runPromise(closed.start())).toEqual({ started: true, problem: null });
      expect(h.events).toHaveLength(1);
      h.events.length = 0;
      const open = await h.setup({ _tag: "ready", accounts: [] });
      expect(await Effect.runPromise(open.start())).toEqual({ started: false, problem: null });
      expect(h.events).toEqual([]);
    });
  });
});
