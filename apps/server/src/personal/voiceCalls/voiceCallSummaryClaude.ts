/**
 * The Claude side of a call summary (Harout, 16 Oct 2026: the summary should be
 * written by Claude Haiku 5.5 reading the transcript, not Gemini Flash Lite).
 *
 * It is the same tool-less, one-shot structured call the app already makes for
 * chat titles, branch names and the memory tidy-up: the owner's own Claude Code
 * subscription through the Claude CLI (`claude -p --output-format json
 * --json-schema ... --tools ""`), on the Haiku 5.5 text-generation default at
 * **medium** effort (Harout's decision, 16 Oct 2026), with no tools and no
 * checkout. No API key is added and nothing new is configured:
 * `PERSONAL_TEXTGEN_MODEL` keeps working exactly as it does for a title, and
 * naming the effort here is what stops the text-generation path adding its own
 * low background effort for exactly this model.
 *
 * Two things about this file are load-bearing:
 *
 * 1. **It is one service tag, so a test can stand in for it.** The summary
 *    worker never reaches into the provider registry itself; it asks this
 *    service, which is why the worker's own tests can prove the Claude-first
 *    order without a Claude CLI, a subscription or a network.
 * 2. **The answer goes through the one shared parser.** Claude returns the JSON
 *    object the CLI was told to produce; this module turns it back into text and
 *    hands it to `parseVoiceCallSummary`, so the caps, the duplicate check and
 *    the fixed short-call line are applied in exactly one place for every model.
 */
import { ProviderInstanceId, type VoiceCallSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CLAUDE_TEXT_GENERATION_DEFAULT_MODEL,
  resolveTextGenerationModel,
} from "../../provider/claudeBackgroundModels.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { VoiceCallSummaryAnswer, summaryFromAnswerObject } from "./voiceCallSummary.ts";

/** The provider instance every Claude background text job in this app runs through. */
export const VOICE_CALL_SUMMARY_CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

/**
 * The effort the summary runs at (Harout's decision, 16 Oct 2026): **medium**,
 * not the low a title uses. A summary is a background job, so its latency does
 * not matter, but its judgement does: what counts as a finding or a decision is
 * exactly the thing this model gets wrong at low. Naming it on the selection
 * also stops the text-generation path folding in its own low background effort
 * for the default model, so this is the effort that really reaches the CLI.
 */
export const VOICE_CALL_SUMMARY_CLAUDE_EFFORT = "medium";

export class VoiceCallSummaryClaude extends Context.Service<
  VoiceCallSummaryClaude,
  {
    /**
     * The model this path really asks for, after the `PERSONAL_TEXTGEN_MODEL`
     * kill switch: the id recorded on the summary as `model`.
     */
    readonly model: string;
    /** The effort the request really names, for the proof and the stored log line. */
    readonly effort: string;
    /**
     * One transcript prompt answered by Claude, or null when it answered
     * nothing the parser can use. Fails with a short reason (never the model's
     * words, never a transcript) when the call itself could not be made.
     */
    readonly ask: (prompt: string) => Effect.Effect<VoiceCallSummary | null, string>;
  }
>()("t3/personal/voiceCalls/voiceCallSummaryClaude") {}

export const claudeLayer = Layer.effect(
  VoiceCallSummaryClaude,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same resolution the title path does: the default, or what the kill
    // switch pins. The effort is named on the selection below, so the
    // text-generation path keeps it instead of adding its low default.
    const model = resolveTextGenerationModel(CLAUDE_TEXT_GENERATION_DEFAULT_MODEL);
    return VoiceCallSummaryClaude.of({
      model,
      effort: VOICE_CALL_SUMMARY_CLAUDE_EFFORT,
      ask: (prompt) =>
        Effect.gen(function* () {
          const instance = yield* registry.getInstance(VOICE_CALL_SUMMARY_CLAUDE_INSTANCE);
          const generate = instance?.textGeneration.generateStructured;
          // No Claude provider instance: not an error the owner should ever see,
          // just "Claude is unavailable" and the caller falls back to Gemini.
          if (generate === undefined) {
            return yield* Effect.fail("the Claude provider instance is not registered");
          }
          const answer = yield* generate({
            prompt,
            outputSchema: VoiceCallSummaryAnswer,
            modelSelection: {
              instanceId: VOICE_CALL_SUMMARY_CLAUDE_INSTANCE,
              model,
              options: [{ id: "effort", value: VOICE_CALL_SUMMARY_CLAUDE_EFFORT }],
            },
          }).pipe(
            // The class only. A TextGenerationError's detail can carry CLI
            // stderr, and this file never puts the owner's words in a log.
            Effect.mapError((error) => error._tag),
          );
          return summaryFromAnswerObject(answer);
        }),
    });
  }),
);
