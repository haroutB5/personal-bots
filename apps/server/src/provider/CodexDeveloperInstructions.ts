import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import {
  buildRuntimeInstructions,
  withBotInstructions,
} from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * Codex estimates 4 bytes per token and truncates the middle of an entry over
 * 1,000 tokens, so every entry stays under 4,000 bytes (with some headroom).
 */
const CODEX_CONTEXT_ENTRY_MAX_BYTES = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES - 200;

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

/**
 * Splits text into ordered pieces that each fit one context entry, breaking at
 * line ends, or inside a line only when that line alone is too long.
 */
function splitCodexContextValue(text: string): ReadonlyArray<string> {
  const pieces: Array<string> = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (byteLength(candidate) <= CODEX_CONTEXT_ENTRY_MAX_BYTES) {
      current = candidate;
      continue;
    }
    if (current.length > 0) pieces.push(current);
    let rest = line;
    while (byteLength(rest) > CODEX_CONTEXT_ENTRY_MAX_BYTES) {
      // Grow a cut from a quarter of the budget (4 bytes max per UTF-16 unit
      // pair) until the next unit would overflow.
      let cut = Math.floor(CODEX_CONTEXT_ENTRY_MAX_BYTES / 4);
      while (byteLength(rest.slice(0, cut + 1)) <= CODEX_CONTEXT_ENTRY_MAX_BYTES) cut += 1;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/**
 * Bot persona entries `t3_code_bot_01`, `t3_code_bot_02`, ... A persona with
 * app rules runs well past one entry. Each piece of a split persona carries its
 * position, so it reads correctly whatever order Codex renders the keys in.
 */
function botContextEntries(
  botInstructions: string | undefined,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const bot = withBotInstructions("", botInstructions).trim();
  if (!bot) return {};
  const pieces = splitCodexContextValue(bot);
  const label = (index: number) =>
    pieces.length === 1 ? "" : `[bot instructions, part ${index + 1} of ${pieces.length}]\n`;
  return Object.fromEntries(
    pieces.map((piece, index) => [
      `t3_code_bot_${String(index + 1).padStart(2, "0")}`,
      { kind: "application", value: `${label(index)}${piece}` },
    ]),
  );
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  botInstructions?: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    ...botContextEntries(botInstructions),
  };
}
