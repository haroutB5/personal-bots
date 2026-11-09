/**
 * DeepSeek instance settings. The API key is a secret instance environment
 * entry, not a field here, and the endpoint is fixed in the driver.
 *
 * @module provider-deepseek/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DeepSeekSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude Agent SDK binary used for DeepSeek sessions.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Config dir path",
        description:
          "Isolated DeepSeek config directory. Keeps DeepSeek state separate from Claude.",
        providerSettingsForm: {
          placeholder: "~/.claude-t3-deepseek",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    engine: Schema.Literals(["dsh", "claude-code"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("dsh" as const)),
      Schema.annotateKey({
        title: "Engine",
        description:
          "DeepSeek Harness runs DeepSeek bots on DeepSeek's own agent harness. Claude Code runs them on the Claude Agent SDK against DeepSeek's Anthropic-compatible endpoint. A change applies from the next session; an open chat carries over from its text history.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "dsh", label: "DeepSeek Harness (dsh)" },
            { value: "claude-code", label: "Claude Code" },
          ],
          clearWhenEmpty: "omit",
        },
      }),
    ),
    dshRuntimePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Harness path",
        description:
          "Where the DeepSeek Harness runtime is installed. Empty uses the pinned install under your home directory.",
        providerSettingsForm: {
          placeholder: "~/.personal-bots/runtimes/dsh-0.2.1-rc.2",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    peakSwitch: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Use Claude Sonnet 5.5 High during DeepSeek peak hours",
        description:
          "DeepSeek bills double from 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday. While this is on, every bot on this instance runs its next turns on Claude Sonnet 5.5 High during those hours and moves back when they end. A running turn is never interrupted. PERSONAL_DEEPSEEK_PEAK_SWITCH=off turns it off server-wide.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["engine", "peakSwitch", "dshRuntimePath", "binaryPath", "homePath"],
  },
);
export type DeepSeekSettings = typeof DeepSeekSettings.Type;
