import type { PersonalTaskWorkRecord } from "@t3tools/contracts";

import { looksLikeSecret, redactSecrets } from "../secretText.ts";

/**
 * A task's work record: pure functions that build, update and print it. The
 * record is small on purpose (a few hundred tokens) and never holds a secret:
 * every text goes through the same check as memory.
 *
 * Kill switch for feeding it to a reopened task as a fresh session:
 * `T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS` (0 = never; default 60000).
 */

export const WORK_RECORD_LIMITS = {
  objective: 600,
  decision: 300,
  decisions: 12,
  evidenceLabel: 80,
  evidenceRef: 300,
  evidence: 12,
  outstandingItem: 240,
  outstanding: 10,
  nextStep: 300,
  lastResult: 1_500,
  update: 300,
  updates: 5,
} as const;

/** Context size (tokens) at which a reopened task starts a fresh session by default. */
export const REOPEN_FRESH_DEFAULT_TOKENS = 60_000;
export const REOPEN_FRESH_ENV = "T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS";

/** The threshold from the environment: 0 or "off" never starts fresh. */
export const reopenFreshTokens = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env[REOPEN_FRESH_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return REOPEN_FRESH_DEFAULT_TOKENS;
  if (raw === "off") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : REOPEN_FRESH_DEFAULT_TOKENS;
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** Text that may be stored: clipped, with credential-shaped parts replaced. */
const safe = (text: string, max: number): string => {
  const flat = clip(text, max);
  return looksLikeSecret(flat) ? clip(redactSecrets(flat), max) : flat;
};

export const emptyWorkRecord = (objective: string, nowIso: string): PersonalTaskWorkRecord => ({
  objective: safe(objective, WORK_RECORD_LIMITS.objective),
  decisions: [],
  evidence: [],
  outstanding: [],
  nextStep: "",
  lastStatus: null,
  lastResult: "",
  updates: [],
  updatedAt: nowIso,
});

/** What a bot may change: decisions and evidence are added to, outstanding and nextStep replaced. */
export interface WorkRecordPatch {
  readonly objective?: string | undefined;
  readonly decisions?: ReadonlyArray<string> | undefined;
  readonly evidence?: ReadonlyArray<{ readonly label: string; readonly ref: string }> | undefined;
  readonly outstanding?: ReadonlyArray<string> | undefined;
  readonly nextStep?: string | undefined;
}

const dedupeKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const addDistinct = <T>(
  current: ReadonlyArray<T>,
  added: ReadonlyArray<T>,
  key: (item: T) => string,
  max: number,
): ReadonlyArray<T> => {
  const out = [...current];
  for (const item of added) {
    if (!out.some((existing) => key(existing) === key(item))) out.push(item);
  }
  // The newest are kept when it overflows.
  return out.slice(-max);
};

/** The record with a bot's patch applied. */
export function applyWorkRecordPatch(
  record: PersonalTaskWorkRecord,
  patch: WorkRecordPatch,
  nowIso: string,
): PersonalTaskWorkRecord {
  const L = WORK_RECORD_LIMITS;
  const decisions = (patch.decisions ?? [])
    .map((text) => safe(text, L.decision))
    .filter((text) => text.length > 0);
  const evidence = (patch.evidence ?? [])
    .map((item) => ({
      label: safe(item.label, L.evidenceLabel),
      ref: safe(item.ref, L.evidenceRef),
    }))
    .filter((item) => item.ref.length > 0);
  return {
    ...record,
    objective:
      patch.objective === undefined ? record.objective : safe(patch.objective, L.objective),
    decisions: addDistinct(record.decisions, decisions, dedupeKey, L.decisions),
    evidence: addDistinct(record.evidence, evidence, (item) => item.ref, L.evidence),
    outstanding:
      patch.outstanding === undefined
        ? record.outstanding
        : patch.outstanding
            .map((text) => safe(text, L.outstandingItem))
            .filter((text) => text.length > 0)
            .slice(0, L.outstanding),
    nextStep: patch.nextStep === undefined ? record.nextStep : safe(patch.nextStep, L.nextStep),
    updatedAt: nowIso,
  };
}

const URL_PATTERN = /https?:\/\/[^\s)>\]"']+/g;
const PATH_PATTERN = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|~\/)[^\s)>\]"'`,;]+/g;

/** Links and file paths a result names, as evidence: at most `max`, once each. */
export function evidenceFromText(
  text: string,
  max = 6,
): ReadonlyArray<{ readonly label: string; readonly ref: string }> {
  const found: Array<{ label: string; ref: string }> = [];
  const push = (ref: string, label: string) => {
    const trimmed = ref.replace(/[.,;:]+$/, "");
    if (trimmed.length < 8 || looksLikeSecret(trimmed)) return;
    if (!found.some((item) => item.ref === trimmed)) found.push({ label, ref: trimmed });
  };
  for (const match of text.matchAll(URL_PATTERN)) push(match[0], "link");
  for (const match of text.matchAll(PATH_PATTERN)) push(match[0], "file");
  return found.slice(0, max);
}

/** The record after an attempt ended: its status and clipped result, and the evidence it names. */
export function recordAttemptEnd(
  record: PersonalTaskWorkRecord,
  end: {
    readonly status: string;
    readonly summary: string | null;
    readonly message: string | null;
  },
  nowIso: string,
): PersonalTaskWorkRecord {
  const L = WORK_RECORD_LIMITS;
  const body = end.summary ?? end.message ?? "";
  const withEvidence = applyWorkRecordPatch(record, { evidence: evidenceFromText(body) }, nowIso);
  return {
    ...withEvidence,
    lastStatus: end.status,
    lastResult: safe(body, L.lastResult),
    // An attempt that did not finish leaves its reason where the next step is read from.
    outstanding:
      end.status === "completed" || withEvidence.outstanding.length > 0
        ? withEvidence.outstanding
        : [safe(`Ended ${end.status}${end.message ? `: ${end.message}` : ""}`, L.outstandingItem)],
  };
}

/** The record after the task was steered: the update is kept, newest last. */
export function recordSteer(
  record: PersonalTaskWorkRecord,
  text: string,
  nowIso: string,
): PersonalTaskWorkRecord {
  const L = WORK_RECORD_LIMITS;
  const cleaned = safe(text.replace(/^update from [^:\n]{1,80}:\s*/i, ""), L.update);
  if (cleaned.length === 0) return record;
  return {
    ...record,
    updates: [...record.updates, { at: nowIso, text: cleaned }].slice(-L.updates),
    updatedAt: nowIso,
  };
}

/** Whether the record says anything beyond the objective the task was handed. */
export const workRecordHasContent = (record: PersonalTaskWorkRecord): boolean =>
  record.decisions.length > 0 ||
  record.evidence.length > 0 ||
  record.outstanding.length > 0 ||
  record.nextStep.length > 0 ||
  record.lastResult.length > 0 ||
  record.updates.length > 0;

/** The record as the bot reads it at the start of a fresh session. */
export function renderWorkRecord(record: PersonalTaskWorkRecord): string {
  const lines: Array<string> = ["Work record (kept by the app, not from this chat):"];
  if (record.objective.length > 0) lines.push(`Objective: ${record.objective}`);
  if (record.decisions.length > 0) {
    lines.push("Decisions:", ...record.decisions.map((text) => `- ${text}`));
  }
  if (record.evidence.length > 0) {
    lines.push("Evidence:", ...record.evidence.map((item) => `- ${item.label}: ${item.ref}`));
  }
  if (record.lastResult.length > 0) {
    lines.push(`Last result (${record.lastStatus ?? "unknown"}): ${record.lastResult}`);
  }
  if (record.outstanding.length > 0) {
    lines.push("Outstanding:", ...record.outstanding.map((text) => `- ${text}`));
  }
  if (record.nextStep.length > 0) lines.push(`Next step: ${record.nextStep}`);
  if (record.updates.length > 0) {
    lines.push("Updates sent to this task:", ...record.updates.map((item) => `- ${item.text}`));
  }
  return lines.join("\n");
}

/** A rough token count for text: about four characters each. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
