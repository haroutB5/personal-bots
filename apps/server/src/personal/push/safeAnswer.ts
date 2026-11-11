import type { PhonePushKind } from "@t3tools/contracts";

export const INLINE_MAX_OPTIONS = 3;
export const INLINE_MAX_LABEL_LENGTH = 20;

/**
 * Words that make an option unsafe to send from a notification, SPEC 5b. A
 * word matches where a word starts, so "deployment" and "pushed" match too:
 * a false refusal only costs the phone a tap into the app.
 */
export const DESTRUCTIVE_WORDS = [
  "delete",
  "remove",
  "drop",
  "reset",
  "wipe",
  "revoke",
  "rotate",
  "overwrite",
  "discard",
  "force",
  "uninstall",
  "deploy",
  "publish",
  "merge",
  "push",
  "pay",
  "buy",
  "send",
  "sign out",
  "cancel",
] as const;

const DESTRUCTIVE_PATTERN = new RegExp(
  `\\b(?:${DESTRUCTIVE_WORDS.map((word) => word.replace(/\s+/g, "[\\s-]*")).join("|")})`,
  "i",
);

export const hasDestructiveWord = (text: string): boolean => DESTRUCTIVE_PATTERN.test(text);

export interface PendingQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly value?: string | undefined;
}

export interface PendingQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect?: boolean | undefined;
  readonly options: ReadonlyArray<PendingQuestionOption>;
}

export const INLINE_REFUSALS = [
  "approval-request",
  "sign-in-request",
  "secret-request",
  "not-a-question",
  "several-questions",
  "multi-select",
  "option-count",
  "label-too-long",
  "duplicate-label",
  "destructive-word",
] as const;

export type InlineRefusal = (typeof INLINE_REFUSALS)[number];

export const isInlineRefusal = (value: string): value is InlineRefusal =>
  (INLINE_REFUSALS as ReadonlyArray<string>).includes(value);

export type InlineVerdict =
  | { readonly _tag: "Inline"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "Refused"; readonly reason: InlineRefusal };

const refused = (reason: InlineRefusal): InlineVerdict => ({ _tag: "Refused", reason });

const REFUSAL_BY_KIND: Readonly<Record<PhonePushKind, InlineRefusal | null>> = {
  question: null,
  approval: "approval-request",
  "sign-in": "sign-in-request",
  secret: "secret-request",
  "chat-reply": "not-a-question",
  failure: "not-a-question",
  task: "not-a-question",
  test: "not-a-question",
};

/** Whether a notification of this kind can be answered from the phone at all. */
export const kindRefusal = (kind: PhonePushKind): InlineRefusal | null => REFUSAL_BY_KIND[kind];

const textsOf = (question: PendingQuestion): ReadonlyArray<string> => [
  question.header,
  question.question,
  ...question.options.flatMap((option) => [option.label, option.description]),
];

/**
 * The server's one decision on whether a pending request may be answered from
 * a notification. The phone shows the labels it is given and never decides.
 */
export function inlineVerdict(
  kind: PhonePushKind,
  questions: ReadonlyArray<PendingQuestion>,
): InlineVerdict {
  const byKind = kindRefusal(kind);
  if (byKind !== null) return refused(byKind);
  const [only, ...rest] = questions;
  if (only === undefined || rest.length > 0) return refused("several-questions");
  if (only.multiSelect === true) return refused("multi-select");
  if (only.options.length < 1 || only.options.length > INLINE_MAX_OPTIONS) {
    return refused("option-count");
  }
  const labels = only.options.map((option) => option.label.trim());
  if (labels.some((label) => [...label].length > INLINE_MAX_LABEL_LENGTH)) {
    return refused("label-too-long");
  }
  if (new Set(labels).size !== labels.length) return refused("duplicate-label");
  if (textsOf(only).some(hasDestructiveWord)) return refused("destructive-word");
  return { _tag: "Inline", labels };
}

/**
 * The answer record the orchestrator takes for a chosen label, or null when
 * the label is not one the notification offered.
 */
export function answersForChoice(
  questions: ReadonlyArray<PendingQuestion>,
  choice: string,
): Record<string, string> | null {
  const [only] = questions;
  if (only === undefined) return null;
  const picked = only.options.find((option) => option.label.trim() === choice.trim());
  if (picked === undefined) return null;
  return { [only.id]: picked.value ?? picked.label };
}
