import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PersonalConnectionsError,
  type PersonalEmailStartResult,
  type PersonalEmailStatus,
  type PersonalEmailUseAccountsInput,
  type PersonalEmailUseAccountsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PersonalConnectionService } from "../../service.ts";
import { CommonpostClient } from "./commonpostClient.ts";
import { THUNDERBIRD_PROFILE_NAME } from "./pins.ts";
import { allowlistWritten, renderUserJs, resolveProfileDir, serverKeyOf } from "./profile.ts";
import { ThunderbirdProcess } from "./thunderbirdProcess.ts";

const SIZE_CACHE_MS = 60_000;

export interface ThunderbirdSetupConfig {
  readonly home: string;
  readonly profileName: string;
}

export const defaultThunderbirdSetupConfig = (
  home: string = NodeOS.homedir(),
): ThunderbirdSetupConfig => ({ home, profileName: THUNDERBIRD_PROFILE_NAME });

/**
 * What the owner does in Settings, Integrations, Email: see where Thunderbird
 * stands, open it, and tell hbots which of its accounts bots may use. The
 * second is the only place the allowlist and the mailbox rows are written, so
 * the two cannot disagree.
 */
export class ThunderbirdSetup extends Context.Service<
  ThunderbirdSetup,
  {
    readonly status: () => Effect.Effect<PersonalEmailStatus>;
    readonly useAccounts: (
      input: PersonalEmailUseAccountsInput,
    ) => Effect.Effect<PersonalEmailUseAccountsResult, PersonalConnectionsError>;
    readonly start: () => Effect.Effect<PersonalEmailStartResult>;
  }
>()("t3/personal/connections/email/thunderbird/ThunderbirdSetup") {}

const directorySize = async (root: string): Promise<number> => {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try {
          total += (await NodeFSP.stat(path)).size;
        } catch {
          continue;
        }
      }
    }
  }
  return total;
};

const readText = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const writeAtomically = (path: string, text: string) => {
  const temp = `${path}.hbots-tmp`;
  NodeFS.writeFileSync(temp, text, { mode: 0o600 });
  NodeFS.renameSync(temp, path);
};

const problem = (message: string): PersonalEmailUseAccountsResult => ({
  changed: false,
  problem: message,
});

export const makeThunderbirdSetup = (config: ThunderbirdSetupConfig) =>
  Effect.gen(function* () {
    const client = yield* CommonpostClient;
    const processes = yield* ThunderbirdProcess;
    const connections = yield* PersonalConnectionService;

    let sizeCache: { readonly at: number; readonly bytes: number | null } | null = null;

    const profileSize = (profileDir: string | null) =>
      Effect.gen(function* () {
        if (profileDir === null) return null;
        const now = yield* Clock.currentTimeMillis;
        if (sizeCache !== null && now - sizeCache.at < SIZE_CACHE_MS) return sizeCache.bytes;
        const bytes = yield* Effect.promise(() => directorySize(profileDir));
        sizeCache = { at: now, bytes };
        return bytes;
      });

    const status = Effect.fn("ThunderbirdSetup.status")(function* () {
      const profileDir = resolveProfileDir(config.home, config.profileName);
      const userJs = profileDir === null ? null : readText(NodePath.join(profileDir, "user.js"));
      const thunderbird = yield* client.status();
      return {
        thunderbird,
        accountsConfirmed: userJs !== null && allowlistWritten(userJs),
        profileSizeBytes: yield* profileSize(profileDir),
      } satisfies PersonalEmailStatus;
    });

    const useAccounts = Effect.fn("ThunderbirdSetup.useAccounts")(function* (
      input: PersonalEmailUseAccountsInput,
    ) {
      const current = yield* client.status();
      if (current._tag !== "ready") {
        return problem("Thunderbird has to be open before accounts can be chosen.");
      }
      const chosen = [];
      for (const accountId of new Set(input.accountIds)) {
        const account = current.accounts.find((entry) => entry.accountId === accountId);
        if (account === undefined) {
          return problem("Thunderbird no longer lists one of those accounts. Check it again.");
        }
        if (account.serverType !== "imap") {
          return problem(`${account.address} is not an IMAP account. Add it again as IMAP.`);
        }
        chosen.push(account);
      }

      const profileDir = resolveProfileDir(config.home, config.profileName);
      if (profileDir === null) return problem("The hbots mail profile was not found.");
      const prefsJs = readText(NodePath.join(profileDir, "prefs.js")) ?? "";
      const offlineServers: Array<string> = [];
      for (const account of chosen) {
        const key = serverKeyOf(prefsJs, account.accountId);
        if (key === null) {
          return problem(`Thunderbird has not saved ${account.address} yet. Try again shortly.`);
        }
        offlineServers.push(key);
      }

      const userJsPath = NodePath.join(profileDir, "user.js");
      const next = renderUserJs({
        allowedAccounts: chosen.map((account) => account.accountId),
        offlineServers,
      });
      const changed = readText(userJsPath) !== next;
      if (changed) {
        yield* processes.terminate();
        yield* Effect.try({
          try: () => writeAtomically(userJsPath, next),
          catch: () =>
            new PersonalConnectionsError({ message: "The mail settings were not saved." }),
        });
        yield* processes.launch();
      }

      for (const account of chosen) {
        yield* connections.connectLocalMailbox({
          vendorId: account.vendor,
          address: account.address,
        });
      }
      return { changed, problem: null } satisfies PersonalEmailUseAccountsResult;
    });

    const start = Effect.fn("ThunderbirdSetup.start")(function* () {
      if (yield* processes.running()) return { started: false, problem: null };
      return yield* processes.launch().pipe(
        Effect.as({ started: true, problem: null }),
        Effect.catch((error) => Effect.succeed({ started: false, problem: error.message })),
      );
    });

    return ThunderbirdSetup.of({
      status,
      start,
      useAccounts: (input) =>
        useAccounts(input).pipe(
          Effect.catchTag("ThunderbirdProcessError", (error) =>
            Effect.fail(new PersonalConnectionsError({ message: error.message })),
          ),
        ),
    });
  });

export const layer = (config: ThunderbirdSetupConfig = defaultThunderbirdSetupConfig()) =>
  Layer.effect(ThunderbirdSetup, makeThunderbirdSetup(config));
