/**
 * The words a "Heaviest right now" row uses for a group: its real provider
 * and its process count.
 *
 * The provider comes from the feed (the bot's own session row), never from a
 * fixed string: QA's live check on 1.66.41 found every bot row hardcoded to
 * "Claude Code", so a Codex or DeepSeek bot was labelled with the wrong
 * runtime. A provider this build has no name for shows no provider at all -
 * an unknown name is a missing fact, not a licence to guess (Harout's
 * preference: show no provider rather than a wrong one).
 */
import {
  PROVIDER_DISPLAY_NAMES,
  type PerformanceGroup,
  type ProviderDriverKind,
} from "@t3tools/contracts";

/**
 * The bots UI names Anthropic's runtime by its product name ("Claude Code"),
 * where the shared provider map says "Claude".
 */
export function performanceProviderLabel(provider: string | null | undefined): string | null {
  if (provider === null || provider === undefined || provider === "") return null;
  if (provider === "claudeAgent") return "Claude Code";
  return PROVIDER_DISPLAY_NAMES[provider as ProviderDriverKind] ?? null;
}

/** "1 process", "5 processes": a single provider CLI is common (QA, 14 Oct). */
export function processCountLabel(count: number): string {
  return `${count} ${count === 1 ? "process" : "processes"}`;
}

/**
 * The line under a group's name. Only a bot names a provider; everything else
 * (Windows, an app, the server) shows the count alone.
 */
export function performanceGroupDetail(
  group: Pick<PerformanceGroup, "kind" | "provider" | "processCount">,
): string {
  const count = processCountLabel(group.processCount);
  if (group.kind !== "bot") return count;
  const provider = performanceProviderLabel(group.provider);
  return provider === null ? count : `${provider} · ${count}`;
}
