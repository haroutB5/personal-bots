import { hasDestructiveWord } from "@t3tools/contracts";

import { formatSpan } from "./projectCards.ts";

/** How a card can be answered. `chat` is the hidden-previews case. */
export type WorkQuestionActions =
  | { readonly kind: "choices"; readonly choices: ReadonlyArray<string> }
  | { readonly kind: "many"; readonly count: number }
  | { readonly kind: "chat" };

export interface WorkQuestionCard {
  /** Stable key: the reply's message id. */
  readonly key: string;
  readonly threadId: string;
  readonly botId: string;
  readonly messageId: string;
  readonly askedAtMs: number;
  /** The question, or "{bot} asked a question" when the bot hides previews. */
  readonly title: string;
  /** "{bot} · {chat title} · asked {span} ago". */
  readonly detail: string;
  readonly actions: WorkQuestionActions;
}

export interface WorkQuestionSource {
  readonly threadId: string;
  readonly botId: string;
  readonly messageId: string;
  readonly askedAtMs: number;
  readonly question: string | null;
  readonly options: ReadonlyArray<string> | null;
}

/**
 * The Work tab's question cards, newest first. A question is hidden while its
 * chat already has a bar in Needs you or is working: that bar is the better
 * place to answer, and two buttons for one chat would race.
 */
export function buildWorkQuestionCards(input: {
  readonly questions: ReadonlyArray<WorkQuestionSource>;
  readonly botName: (botId: string) => string;
  readonly chatTitle: (threadId: string) => string;
  readonly hiddenThreadIds: ReadonlySet<string>;
  readonly nowMs: number;
}): ReadonlyArray<WorkQuestionCard> {
  const cards: WorkQuestionCard[] = [];
  for (const question of input.questions) {
    if (input.hiddenThreadIds.has(question.threadId)) continue;
    const bot = input.botName(question.botId);
    const title = question.question?.trim();
    const actions: WorkQuestionActions =
      question.options === null
        ? { kind: "chat" }
        : question.options.length > 3
          ? { kind: "many", count: question.options.length }
          : { kind: "choices", choices: question.options };
    cards.push({
      key: question.messageId,
      threadId: question.threadId,
      botId: question.botId,
      messageId: question.messageId,
      askedAtMs: question.askedAtMs,
      title: title === undefined || title.length === 0 ? `${bot} asked a question` : title,
      detail: `${bot} · ${input.chatTitle(question.threadId)} · asked ${formatSpan(
        input.nowMs - question.askedAtMs,
      )} ago`,
      actions,
    });
  }
  return cards.toSorted((left, right) => right.askedAtMs - left.askedAtMs);
}

/** A destructive choice asks first; a safe one sends on the tap. */
export const answerNeedsConfirm = (choice: string): boolean => hasDestructiveWord(choice);
