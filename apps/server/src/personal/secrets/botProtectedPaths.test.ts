import { assert, describe, it } from "@effect/vitest";

import {
  botProtectedCommandForms,
  botProtectedPaths,
  botStateDenyEnabled,
  buildClaudeBotPermissionDeny,
  buildOpenCodeBotPermissionRules,
  claudeFileRuleAnchor,
  claudeTailRuleAnchor,
  type BotProtectedPathsInput,
} from "./botProtectedPaths.ts";

const WINDOWS: BotProtectedPathsInput = {
  stateDir: "C:\\Users\\Jo Doe\\.personal-bots\\userdata",
  dbPath: "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\state.sqlite",
  secretsDir: "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\secrets",
  logsDir: "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\logs",
};
const POSIX: BotProtectedPathsInput = {
  stateDir: "/home/jo/.personal-bots/userdata",
  dbPath: "/home/jo/.personal-bots/userdata/state.sqlite",
  secretsDir: "/home/jo/.personal-bots/userdata/secrets",
  logsDir: "/home/jo/.personal-bots/userdata/logs",
};

describe("botProtectedPaths", () => {
  it("lists the secrets folder (read-write) and the database with its three sidecars (write only), no logs", () => {
    assert.deepEqual(botProtectedPaths(WINDOWS), [
      { path: WINDOWS.secretsDir, kind: "dir", access: "read-write" },
      { path: `${WINDOWS.dbPath}`, kind: "file", access: "write" },
      { path: `${WINDOWS.dbPath}-wal`, kind: "file", access: "write" },
      { path: `${WINDOWS.dbPath}-shm`, kind: "file", access: "write" },
      { path: `${WINDOWS.dbPath}-journal`, kind: "file", access: "write" },
    ]);
  });

  describe("Claude Code", () => {
    it("anchors a Windows path at //<drive>/ in POSIX form, spaces kept", () => {
      // https://code.claude.com/docs/en/permissions: C:\Users\alice is /c/Users/alice.
      assert.equal(
        claudeFileRuleAnchor(WINDOWS.secretsDir),
        "//c/Users/Jo Doe/.personal-bots/userdata/secrets",
      );
      assert.equal(
        claudeFileRuleAnchor("c:/Users/x/secrets"),
        "//c/Users/x/secrets",
        "forward slashes and a lowercase drive give the same anchor",
      );
      assert.equal(
        claudeFileRuleAnchor(POSIX.secretsDir),
        "//home/jo/.personal-bots/userdata/secrets",
      );
    });

    it("emits no anchor for relative or UNC paths rather than a rule that may be ignored", () => {
      assert.equal(claudeFileRuleAnchor("userdata\\secrets"), undefined);
      assert.equal(claudeFileRuleAnchor("\\\\server\\share\\userdata\\secrets"), undefined);
      // The tail anchor still covers a UNC state directory.
      assert.equal(
        claudeTailRuleAnchor("\\\\server\\share\\a\\userdata\\secrets"),
        "//**/a/userdata/secrets",
      );
      const relative = buildClaudeBotPermissionDeny({
        stateDir: "x",
        dbPath: "x/state.sqlite",
        secretsDir: "x/secrets",
        logsDir: "x/logs",
      });
      assert.deepEqual(
        relative.filter((rule) => rule.startsWith("Read(") || rule.startsWith("Edit(")),
        [],
      );
    });

    it("escapes the characters gitignore treats as syntax", () => {
      assert.equal(claudeFileRuleAnchor("C:\\Data [2024]\\secrets"), "//c/Data \\[2024\\]/secrets");
    });

    it("denies Read and Edit on the secrets folder and Edit only on the database and sidecars, on both anchors", () => {
      const rules = buildClaudeBotPermissionDeny(WINDOWS);
      for (const base of [
        "//c/Users/Jo Doe/.personal-bots/userdata",
        // The tail anchor: matches under any root, share or long-path prefix.
        "//**/.personal-bots/userdata",
      ]) {
        // The folder itself (what a Grep or Glob path names) and everything under it.
        for (const tool of ["Read", "Edit"]) {
          assert.ok(rules.includes(`${tool}(${base}/secrets)`), `${tool} ${base}/secrets`);
          assert.ok(rules.includes(`${tool}(${base}/secrets/**)`));
        }
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          assert.ok(rules.includes(`Edit(${base}/state.sqlite${suffix})`));
          assert.ok(
            !rules.includes(`Read(${base}/state.sqlite${suffix})`),
            "the database stays readable",
          );
        }
        assert.ok(!rules.some((rule) => rule.includes(`${base}/logs`)), "no rule on the logs");
      }
    });

    it("leaves the database and logs readable from the shell", () => {
      for (const paths of [WINDOWS, POSIX]) {
        const rules = buildClaudeBotPermissionDeny(paths);
        assert.ok(
          !rules.some((rule) => /state\.sqlite|[\\/]logs/.test(rule) && !rule.startsWith("Edit(")),
        );
        assert.ok(!rules.some((rule) => /^(Bash|PowerShell)\(.*(sqlite|logs)/.test(rule)));
        // The secrets folder keeps its command-text rules.
        assert.ok(rules.some((rule) => rule.startsWith("Bash(*") && rule.includes("secrets")));
      }
    });

    it("uses only tools whose path rules Claude Code consults", () => {
      for (const paths of [WINDOWS, POSIX]) {
        for (const rule of buildClaudeBotPermissionDeny(paths)) {
          // Write/Glob/Grep(path) rules are accepted but never consulted.
          assert.match(rule, /^(Read|Edit|Bash|PowerShell)\(/);
        }
      }
    });

    it("adds Bash and PowerShell text rules for every spelling of a Windows path", () => {
      const rules = buildClaudeBotPermissionDeny(WINDOWS);
      const bash = rules.filter((rule) => rule.startsWith("Bash("));
      const powershell = rules.filter((rule) => rule.startsWith("PowerShell("));
      const secrets = "Users/Jo Doe/.personal-bots/userdata/secrets";
      // Case-insensitivity: the drive letter goes in both cases; nothing else is folded.
      for (const form of [
        `C:/${secrets}`,
        `c:/${secrets}`,
        `/c/${secrets}`,
        `C:\\${secrets.replaceAll("/", "\\")}`,
        `c:\\${secrets.replaceAll("/", "\\")}`,
      ]) {
        assert.ok(bash.includes(`Bash(*${form}*)`), form);
      }
      assert.ok(!bash.some((rule) => rule.includes("/C/")), "no uppercase Git Bash drive");
      assert.ok(powershell.includes(`PowerShell(*C:\\${secrets.replaceAll("/", "\\")}*)`));
      assert.ok(!powershell.some((rule) => rule.includes("(*/c/")), "PowerShell never sees /c/");
      // The database is readable from the shell: no text rule names it.
      assert.ok(!bash.some((rule) => rule.includes("state.sqlite")));
      assert.ok(!powershell.some((rule) => rule.includes("state.sqlite")));
      // The tail catches a UNC share or \\?\ spelling of the same folder.
      assert.ok(bash.includes("Bash(*.personal-bots/userdata/secrets*)"));
      assert.ok(bash.includes("Bash(*.personal-bots\\userdata\\secrets*)"));
    });

    it("gives a POSIX host one text form per path and no drive-letter variants", () => {
      const rules = buildClaudeBotPermissionDeny(POSIX);
      assert.ok(rules.includes("Bash(*/home/jo/.personal-bots/userdata/secrets*)"));
      assert.ok(rules.includes("Edit(//home/jo/.personal-bots/userdata/state.sqlite-shm)"));
      assert.ok(rules.includes("Read(//home/jo/.personal-bots/userdata/secrets/**)"));
      assert.ok(!rules.some((rule) => /\*[A-Za-z]:/.test(rule)));
    });

    it("has no duplicates", () => {
      const rules = buildClaudeBotPermissionDeny(WINDOWS);
      assert.equal(new Set(rules).size, rules.length);
    });

    it("lists the command spellings of a drive, UNC and POSIX path", () => {
      assert.deepEqual(botProtectedCommandForms("D:\\a b\\c"), [
        "D:/a b/c",
        "d:/a b/c",
        "/d/a b/c",
        "D:\\a b\\c",
        "d:\\a b\\c",
      ]);
      assert.deepEqual(botProtectedCommandForms("\\\\host\\share\\x"), [
        "//host/share/x",
        "\\\\host\\share\\x",
      ]);
      assert.deepEqual(botProtectedCommandForms("/srv/x"), ["/srv/x"]);
      assert.deepEqual(botProtectedCommandForms("relative/x"), []);
    });
  });

  describe("OpenCode", () => {
    // OpenCode's matcher (packages/opencode/src/util/wildcard.ts): `\` becomes
    // `/` on both sides, `*` is any text, `?` one character, the whole string
    // must match, and win32 matches case-insensitively.
    const matches = (input: string, pattern: string, win32: boolean) => {
      const subject = input.replaceAll("\\", "/");
      const source = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${source}$`, win32 ? "si" : "s").test(subject);
    };
    const denies = (
      rules: ReadonlyArray<{ permission: string; pattern: string; action: string }>,
      permission: string,
      input: string,
      win32: boolean,
    ) =>
      rules.some(
        (rule) =>
          rule.permission === permission &&
          rule.action === "deny" &&
          matches(input, rule.pattern, win32),
      );

    it("denies read, edit and list on the secrets folder and edit only on the database and sidecars, backslashes or not", () => {
      const rules = buildOpenCodeBotPermissionRules(WINDOWS);
      const secretFile =
        "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\secrets\\data-encryption-key.json";
      for (const permission of ["read", "edit", "list"]) {
        assert.ok(denies(rules, permission, secretFile, true));
        assert.ok(
          denies(rules, permission, secretFile.toLowerCase(), true),
          "win32 is case-insensitive",
        );
        assert.ok(
          denies(
            rules,
            permission,
            "\\\\localhost\\c$\\Users\\Jo Doe\\.personal-bots\\userdata\\secrets\\x",
            true,
          ),
        );
      }
      for (const file of [
        WINDOWS.dbPath,
        `${WINDOWS.dbPath}-wal`,
        `${WINDOWS.dbPath}-shm`,
        `${WINDOWS.dbPath}-journal`,
      ]) {
        assert.ok(denies(rules, "edit", file, true), `edit ${file}`);
        assert.ok(!denies(rules, "read", file, true), `read ${file} stays open`);
        assert.ok(!denies(rules, "list", file, true));
      }
      const logFile = `${WINDOWS.logsDir}\\provider\\events.log`;
      for (const permission of ["read", "edit", "list", "external_directory"]) {
        assert.ok(!denies(rules, permission, logFile, true), `no ${permission} deny on logs`);
      }
      assert.ok(
        !denies(
          rules,
          "read",
          "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\attachments\\a.png",
          true,
        ),
      );
      assert.ok(!denies(rules, "read", "C:\\Users\\Jo Doe\\project\\secrets\\a.txt", true));
    });

    it("denies external_directory for the folders, which gates bash path arguments", () => {
      const rules = buildOpenCodeBotPermissionRules(WINDOWS);
      assert.ok(denies(rules, "external_directory", `${WINDOWS.secretsDir}\\*`, true));
      assert.ok(!denies(rules, "external_directory", `${WINDOWS.logsDir}\\*`, true));
      // A file has no folder rule of its own: the state directory also holds allowed files.
      assert.ok(!denies(rules, "external_directory", `${WINDOWS.stateDir}\\*`, true));
    });

    it("matches command text in bash patterns in forward, backslash and Git Bash spellings", () => {
      const rules = buildOpenCodeBotPermissionRules(WINDOWS);
      for (const command of [
        'cat "C:/Users/Jo Doe/.personal-bots/userdata/secrets/x.bin"',
        'type "C:\\Users\\Jo Doe\\.personal-bots\\userdata\\secrets\\x.bin"',
        'cat "/c/Users/Jo Doe/.personal-bots/userdata/secrets/x.bin"',
      ]) {
        assert.ok(denies(rules, "bash", command, true), command);
      }
      for (const command of [
        "git status --porcelain",
        "sqlite3 state.sqlite .dump",
        'tail -n 50 "C:/Users/Jo Doe/.personal-bots/userdata/logs/server.log"',
      ]) {
        assert.ok(!denies(rules, "bash", command, true), command);
      }
    });

    it("is case-sensitive off Windows", () => {
      const rules = buildOpenCodeBotPermissionRules(POSIX);
      assert.ok(denies(rules, "read", `${POSIX.secretsDir}/x.bin`, false));
      assert.ok(!denies(rules, "read", `${POSIX.secretsDir.toUpperCase()}/x.bin`, false));
    });

    it("only ever emits deny actions", () => {
      for (const rule of buildOpenCodeBotPermissionRules(WINDOWS)) {
        assert.equal(rule.action, "deny");
      }
    });
  });
});

describe("botStateDenyEnabled", () => {
  it("is on unless PERSONAL_BOT_STATE_DENY says off", () => {
    assert.isTrue(botStateDenyEnabled({}));
    assert.isFalse(botStateDenyEnabled({ PERSONAL_BOT_STATE_DENY: "off" }));
    assert.isFalse(botStateDenyEnabled({ T3CODE_PERSONAL_BOT_STATE_DENY: "0" }));
    assert.isTrue(botStateDenyEnabled({ PERSONAL_BOT_STATE_DENY: "on" }));
  });
});
