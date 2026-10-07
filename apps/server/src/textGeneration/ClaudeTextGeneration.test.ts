import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform, isHostWindows } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import type { ClaudeModelCatalog } from "../provider/ClaudeModelCatalog.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const binDir = path.join(dir, "bin");
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source: [
        "const argv = process.argv.slice(2);",
        'const args = argv.join(" ");',
        'const { realpathSync } = await import("node:fs");',
        "",
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "",
        'const permissionIndex = argv.indexOf("--permission-mode");',
        'if (permissionIndex === -1 || argv[permissionIndex + 1] !== "dontAsk") {',
        '  fail("text generation must deny permission prompts", 12);',
        "}",
        'const toolsIndex = argv.indexOf("--tools");',
        'if (toolsIndex === -1 || argv[toolsIndex + 1] !== "") {',
        '  fail("text generation must receive an explicit empty tool set", 6);',
        "}",
        'if (argv.includes("--dangerously-skip-permissions")) {',
        '  fail("text generation must not bypass permissions", 7);',
        "}",
        'if (!argv.includes("--disable-slash-commands")) {',
        '  fail("text generation must disable skills", 8);',
        "}",
        'if (!argv.includes("--strict-mcp-config")) {',
        '  fail("text generation must not load configured MCP servers", 9);',
        "}",
        'const settingsIndex = argv.indexOf("--settings");',
        "if (settingsIndex === -1 || JSON.parse(argv[settingsIndex + 1]).disableAllHooks !== true) {",
        '  fail("text generation must disable hooks", 10);',
        "}",
        "const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;",
        "if (cwdMustNotBe && realpathSync(process.cwd()) === realpathSync(cwdMustNotBe)) {",
        '  fail("text generation ran in the project directory", 11);',
        "}",
        "",
        'let stdinContent = "";',
        "if (!process.stdin.isTTY) {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(chunk);",
        "  }",
        '  stdinContent = Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (argsMustContain && !args.includes(argsMustContain)) {",
        '  fail("args missing expected content", 2);',
        "}",
        "",
        "const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (argsMustNotContain && args.includes(argsMustNotContain)) {",
        '  fail("args contained forbidden content", 3);',
        "}",
        "",
        "const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '  fail("stdin missing expected content", 4);',
        "}",
        "",
        "const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;",
        "if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {",
        '  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);',
        "}",
        "",
        'const modelIndex = argv.indexOf("--model");',
        'const modelArg = modelIndex === -1 ? "" : argv[modelIndex + 1];',
        "const callLog = process.env.T3_FAKE_CLAUDE_CALL_LOG;",
        "if (callLog) {",
        '  const { appendFileSync } = await import("node:fs");',
        '  appendFileSync(callLog, modelArg + "\\n");',
        "}",
        "if (process.env.T3_FAKE_CLAUDE_FAIL_MODEL && modelArg === process.env.T3_FAKE_CLAUDE_FAIL_MODEL) {",
        '  fail("model refused: " + modelArg, 1);',
        "}",
        "",
        "const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;",
        "if (stderrText) {",
        '  process.stderr.write(stderrText + "\\n");',
        "}",
        "",
        'process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        "process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);",
        "",
      ].join("\n"),
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
    /** Replaces the synthetic catalog the text generation resolves models with. */
    catalog?: ClaudeModelCatalog;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* isHostWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      undefined,
      Effect.succeed(input.catalog ?? SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings without passing unsupported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                SYNTHETIC_CLAUDE_THINKING_MODEL,
                [
                  { id: "thinking", value: false },
                  { id: "effort", value: "high" },
                ],
              ),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("keeps a configured custom alias opaque to the Claude CLI", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Keep custom model",
            body: "",
          },
        }),
        argsMustContain: `--model ${SYNTHETIC_CLAUDE_COLLIDING_ALIAS} --settings`,
        claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/custom-model",
            commitSummary: "Keep custom model",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "expanded" },
              ],
            ),
          });

          expect(generated.title).toBe("Keep custom model");
        }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.branch).toBe("call-script");
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  for (const verbose of [false, true]) {
    it.effect(`unwraps a JSON title in ${verbose ? "verbose" : "normal"} Claude output`, () => {
      const result = {
        type: "result",
        structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
      };
      return withFakeClaudeEnv(
        { output: JSON.stringify(verbose ? [result] : result) },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Refresh ev-stg APP ASG instances",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
          }),
      );
    });
  }

  for (const previousTitle of [undefined, "Old thread title"]) {
    it.effect(
      `reads the result from verbose Claude output when ${previousTitle ? "regenerating" : "generating"} a title`,
      () =>
        withFakeClaudeEnv(
          {
            output: JSON.stringify([
              { type: "system", subtype: "init" },
              { type: "assistant", message: { content: [] } },
              { type: "user", message: { content: [] } },
              { type: "rate_limit_event" },
              {
                type: "result",
                subtype: "success",
                result: '{"title":"Refresh ev-stg APP ASG Instances"}',
                structured_output: { title: "Refresh ev-stg APP ASG Instances" },
              },
            ]),
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Refresh ev-stg APP ASG instances",
                previousTitle,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              });

              expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
            }),
        ),
    );
  }

  for (const [name, output] of [
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const) {
    it.effect(`rejects verbose Claude output with ${name}`, () =>
      withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
        }),
      ),
    );
  }

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  describe("background text jobs on Haiku 5.5", () => {
    const HAIKU_5_5 = "claude-haiku-5-5";
    const HAIKU_4_5 = "claude-haiku-4-5";
    const catalogWithHaiku: ClaudeModelCatalog = {
      models: [
        {
          model: {
            slug: HAIKU_5_5,
            name: "Claude Haiku 5.5",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
          runtime: {},
          compatibility: {},
        },
      ],
    };
    const titleOutput = JSON.stringify({ structured_output: { title: "Weekly groceries" } });
    const request = (model: string) => ({
      cwd: process.cwd(),
      message: "Plan the weekly grocery run.",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model,
      },
    });

    /** Sets server env vars (and the fake CLI's call log) for one effect, then restores them. */
    const withEnv = <A, E, R>(vars: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
          Object.assign(process.env, vars);
          return previous;
        }),
        () => effect,
        (previous) =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(previous)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }),
      );
    const callLogOf = (dir: string) => `${dir}/calls.log`;
    const calls = (file: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        return text.split("\n").filter((line) => line.length > 0);
      });
    const inTempDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* body(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-haiku-calls-" }));
      }).pipe(Effect.scoped);

    it.effect("uses Haiku 5.5 with the low effort setting when the job names none", () =>
      inTempDir((dir) =>
        withEnv(
          { T3_FAKE_CLAUDE_CALL_LOG: callLogOf(dir) },
          withFakeClaudeEnv(
            {
              output: titleOutput,
              catalog: catalogWithHaiku,
              argsMustContain: `--model ${HAIKU_5_5} --effort low`,
            },
            (textGeneration) =>
              Effect.gen(function* () {
                const generated = yield* textGeneration.generateThreadTitle(request(HAIKU_5_5));
                expect(generated.title).toBe("Weekly groceries");
                expect(yield* calls(callLogOf(dir))).toEqual([HAIKU_5_5]);
              }),
          ),
        ),
      ),
    );

    it.effect("takes the effort from PERSONAL_TEXTGEN_EFFORT, and sends none when it is off", () =>
      Effect.gen(function* () {
        yield* withEnv(
          { PERSONAL_TEXTGEN_EFFORT: "high" },
          withFakeClaudeEnv(
            {
              output: titleOutput,
              catalog: catalogWithHaiku,
              argsMustContain: `--model ${HAIKU_5_5} --effort high`,
            },
            (textGeneration) =>
              textGeneration.generateThreadTitle(request(HAIKU_5_5)).pipe(Effect.asVoid),
          ),
        );
        yield* withEnv(
          { PERSONAL_TEXTGEN_EFFORT: "off" },
          withFakeClaudeEnv(
            {
              output: titleOutput,
              catalog: catalogWithHaiku,
              argsMustNotContain: "--effort",
            },
            (textGeneration) =>
              textGeneration.generateThreadTitle(request(HAIKU_5_5)).pipe(Effect.asVoid),
          ),
        );
      }),
    );

    it.effect("keeps an effort the job named", () =>
      withFakeClaudeEnv(
        {
          output: titleOutput,
          catalog: catalogWithHaiku,
          argsMustContain: `--model ${HAIKU_5_5} --effort medium`,
        },
        (textGeneration) =>
          textGeneration
            .generateThreadTitle({
              ...request(HAIKU_5_5),
              modelSelection: createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                HAIKU_5_5,
                [{ id: "effort", value: "medium" }],
              ),
            })
            .pipe(Effect.asVoid),
      ),
    );

    it.effect("retries once on Haiku 4.5, with no effort flag, when Haiku 5.5 is refused", () =>
      inTempDir((dir) =>
        withEnv(
          { T3_FAKE_CLAUDE_CALL_LOG: callLogOf(dir), T3_FAKE_CLAUDE_FAIL_MODEL: HAIKU_5_5 },
          withFakeClaudeEnv({ output: titleOutput, catalog: catalogWithHaiku }, (textGeneration) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle(request(HAIKU_5_5));
              expect(generated.title).toBe("Weekly groceries");
              expect(yield* calls(callLogOf(dir))).toEqual([HAIKU_5_5, HAIKU_4_5]);
            }),
          ),
        ),
      ),
    );

    it.effect("fails with the error when the fallback is refused too, after one retry", () =>
      inTempDir((dir) =>
        withEnv(
          { T3_FAKE_CLAUDE_CALL_LOG: callLogOf(dir), T3_FAKE_CLAUDE_FAIL_MODEL: HAIKU_5_5 },
          withFakeClaudeEnv(
            // The fake exits non-zero for every model.
            { output: titleOutput, catalog: catalogWithHaiku, exitCode: 1 },
            (textGeneration) =>
              Effect.gen(function* () {
                const error = yield* Effect.flip(
                  textGeneration.generateThreadTitle(request(HAIKU_5_5)),
                );
                expect(error._tag).toBe("TextGenerationError");
                expect(yield* calls(callLogOf(dir))).toEqual([HAIKU_5_5, HAIKU_4_5]);
              }),
          ),
        ),
      ),
    );

    it.effect("PERSONAL_TEXTGEN_MODEL pins the old model and nothing retries", () =>
      inTempDir((dir) =>
        withEnv(
          { T3_FAKE_CLAUDE_CALL_LOG: callLogOf(dir), PERSONAL_TEXTGEN_MODEL: HAIKU_4_5 },
          withFakeClaudeEnv(
            {
              output: titleOutput,
              catalog: catalogWithHaiku,
              argsMustContain: `--model ${HAIKU_4_5}`,
              argsMustNotContain: "--effort",
            },
            (textGeneration) =>
              Effect.gen(function* () {
                const generated = yield* textGeneration.generateThreadTitle(request(HAIKU_5_5));
                expect(generated.title).toBe("Weekly groceries");
                expect(yield* calls(callLogOf(dir))).toEqual([HAIKU_4_5]);
              }),
          ),
        ),
      ),
    );

    it.effect("a model the owner chose is used as it is: no effort added, no retry", () =>
      inTempDir((dir) =>
        withEnv(
          {
            T3_FAKE_CLAUDE_CALL_LOG: callLogOf(dir),
            T3_FAKE_CLAUDE_FAIL_MODEL: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
          withFakeClaudeEnv({ output: titleOutput, catalog: catalogWithHaiku }, (textGeneration) =>
            Effect.gen(function* () {
              const error = yield* Effect.flip(
                textGeneration.generateThreadTitle(request(SYNTHETIC_CLAUDE_STANDARD_MODEL)),
              );
              expect(error._tag).toBe("TextGenerationError");
              expect(yield* calls(callLogOf(dir))).toEqual([SYNTHETIC_CLAUDE_STANDARD_MODEL]);
            }),
          ),
        ),
      ),
    );
  });
});
