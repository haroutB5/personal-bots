import type { OrchestrationSessionProviderRetry } from "@t3tools/contracts";

/**
 * When and whether a bot chat stopped by a provider limit continues on its
 * own. Pure, so every rule is testable without a clock or a database; the
 * service (`PersonalChatResumeService`) applies it.
 */

/** How often due resumes are looked for. Also the most a resume runs late. */
export const PERSONAL_CHAT_RESUME_SWEEP_MS = 15_000;
/** Resumes of chats on one provider start at least this far apart. */
export const PERSONAL_CHAT_RESUME_PROVIDER_GAP_MS = 15_000;
/** Added to the reset: a window reported as reset can still refuse the first second. */
export const PERSONAL_CHAT_RESUME_GRACE_MS = 5_000;
/** A reset further out than this (beyond a weekly window) is not believed. */
export const PERSONAL_CHAT_RESUME_MAX_WAIT_MS = 8 * 24 * 60 * 60_000;
/**
 * Automatic continues in a row, with no message from the owner in between.
 * A limit that is hit again straight after its reported reset must not loop.
 */
export const PERSONAL_CHAT_RESUME_MAX_CONSECUTIVE = 2;
/** A due chat whose session is busy (not with a new message) waits at most this long. */
export const PERSONAL_CHAT_RESUME_BUSY_WAIT_MS = 30 * 60_000;
/** A resumed turn gives its task slot back after this long, however it ends. */
export const PERSONAL_CHAT_RESUME_SLOT_MAX_MS = 3 * 60 * 60_000;

/** Server-written turn message ids: `personal-resume-<resumeId>`. */
export const PERSONAL_RESUME_MESSAGE_ID_PREFIX = "personal-resume-";
/** Server-written notice rows: `personal-notice-<resumeId>`. */
export const PERSONAL_NOTICE_MESSAGE_ID_PREFIX = "personal-notice-";

export const isPersonalResumeMessageId = (messageId: string) =>
  messageId.startsWith(PERSONAL_RESUME_MESSAGE_ID_PREFIX);

/** The text the provider gets. The owner sees a system row, not this. */
export const PERSONAL_CHAT_RESUME_PROMPT =
  "[Auto-continue after usage reset] Your previous turn stopped because the usage limit was reached. The limit has now reset. Continue where you left off, without repeating work that is already done.";

export type LimitHitDecision =
  | { readonly kind: "schedule"; readonly resumeAtMs: number }
  | {
      readonly kind: "notice_only";
      readonly reason: "no_reset" | "reset_too_far" | "too_many_resumes";
    };

/**
 * A limit hit with a reported reset continues after it; without one it only
 * shows the notice. A reset already past (a lagging report) continues soon.
 */
export function decideLimitHit(input: {
  readonly retry: Pick<OrchestrationSessionProviderRetry, "retryAt">;
  readonly nowMs: number;
  /** Automatic continues in this chat since the owner last wrote. */
  readonly consecutiveResumes: number;
}): LimitHitDecision {
  if (input.consecutiveResumes >= PERSONAL_CHAT_RESUME_MAX_CONSECUTIVE) {
    return { kind: "notice_only", reason: "too_many_resumes" };
  }
  const retryAtMs =
    input.retry.retryAt === undefined ? Number.NaN : Date.parse(input.retry.retryAt);
  if (!Number.isFinite(retryAtMs)) return { kind: "notice_only", reason: "no_reset" };
  if (retryAtMs - input.nowMs > PERSONAL_CHAT_RESUME_MAX_WAIT_MS) {
    return { kind: "notice_only", reason: "reset_too_far" };
  }
  return {
    kind: "schedule",
    resumeAtMs: Math.max(retryAtMs, input.nowMs) + PERSONAL_CHAT_RESUME_GRACE_MS,
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  antigravity: "Antigravity",
};

/** "Claude", "Codex": the provider as the owner knows it. */
export function providerLabel(providerName: string | null | undefined): string {
  if (providerName == null || providerName.trim() === "") return "Provider";
  return PROVIDER_LABELS[providerName] ?? providerName;
}

/**
 * "usage limit" for a plan window (Claude five_hour/seven_day, Codex's usage
 * limit), "rate limit" for anything else (an API 429 the SDK gave up on).
 */
export function limitWord(reason: string | undefined): string {
  if (reason === undefined) return "usage limit";
  return /five_hour|seven_day|overage|usage|limit_exceeded|limitexceeded/i.test(reason)
    ? "usage limit"
    : "rate limit";
}

/** The owner's clock: the server renders fallback text, the client renders from the marker. */
export const PERSONAL_NOTICE_TIME_ZONE = "Europe/London";

/** "23:00" today, "Tue 09:00" on another day. */
export function formatResumeTime(
  resumeAtMs: number,
  nowMs: number,
  timeZone: string = PERSONAL_NOTICE_TIME_ZONE,
): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resumeAtMs);
  if (day(resumeAtMs) === day(nowMs)) return time;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(
    resumeAtMs,
  );
  return `${weekday} ${time}`;
}

/** The paused row's text (the client re-renders the time in its own zone). */
export function pausedNoticeText(input: {
  readonly provider: string;
  readonly reason: string | undefined;
  readonly decision: LimitHitDecision;
  readonly nowMs: number;
}): string {
  const head = `Paused: ${input.provider} ${limitWord(input.reason)}.`;
  const decision = input.decision;
  if (decision.kind === "schedule") {
    return `${head} Continues at ${formatResumeTime(decision.resumeAtMs, input.nowMs)}.`;
  }
  switch (decision.reason) {
    case "too_many_resumes":
      return `${head} It already continued on its own, so send a message to continue.`;
    case "no_reset":
    case "reset_too_far":
      return `${head} No reset time was reported, so send a message to continue.`;
  }
}

export const RESUMED_NOTICE_TEXT = "Auto-continue after usage reset";
