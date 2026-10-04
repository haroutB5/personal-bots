import type { JSX } from "react";

import type { PersonalTaskWorkRecord } from "@t3tools/contracts";

const LABEL =
  "text-[12px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase";
const LIST = "mt-0.5 flex flex-col gap-1";
const ITEM = "text-[14px] leading-snug break-words text-[var(--personal-text)]";

/** Whether the record holds anything the bot or the server added beyond the objective. */
export function workRecordIsEmpty(record: PersonalTaskWorkRecord): boolean {
  return (
    record.decisions.length === 0 &&
    record.evidence.length === 0 &&
    record.outstanding.length === 0 &&
    record.nextStep.length === 0 &&
    record.lastResult.length === 0 &&
    record.updates.length === 0
  );
}

/**
 * A task's work record, tucked away: the short state that outlives its chat
 * (decisions, evidence, what is left, the next step). A reopened task starts
 * from it when its chat has grown long. Read only.
 */
export function WorkRecordCard({ record }: { record: PersonalTaskWorkRecord }): JSX.Element | null {
  if (workRecordIsEmpty(record)) return null;
  return (
    <details
      data-testid="work-record"
      className="rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] px-4 py-3"
    >
      <summary className="min-h-9 cursor-pointer py-1 text-[14px] font-semibold text-[var(--personal-text)] select-none">
        Work record
      </summary>
      <div className="mt-1 flex flex-col gap-3">
        <p className="text-[13px] leading-snug text-[var(--personal-text-secondary)]">
          What this task keeps apart from its chat. If it is reopened after a long chat, it starts
          from this.
        </p>
        {record.nextStep.length > 0 ? (
          <section>
            <p className={LABEL}>Next step</p>
            <p className={ITEM}>{record.nextStep}</p>
          </section>
        ) : null}
        {record.outstanding.length > 0 ? (
          <section>
            <p className={LABEL}>Left to do</p>
            <ul className={LIST}>
              {record.outstanding.map((text) => (
                <li key={text} className={ITEM}>
                  {text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {record.decisions.length > 0 ? (
          <section>
            <p className={LABEL}>Decisions</p>
            <ul className={LIST}>
              {record.decisions.map((text) => (
                <li key={text} className={ITEM}>
                  {text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {record.evidence.length > 0 ? (
          <section>
            <p className={LABEL}>Evidence</p>
            <ul className={LIST}>
              {record.evidence.map((item) => (
                <li key={item.ref} className={ITEM}>
                  <span className="text-[var(--personal-text-secondary)]">{item.label}: </span>
                  <span className="[overflow-wrap:anywhere]">{item.ref}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {record.lastResult.length > 0 ? (
          <section>
            <p className={LABEL}>
              Last result{record.lastStatus === null ? "" : ` (${record.lastStatus})`}
            </p>
            <p className={ITEM}>{record.lastResult}</p>
          </section>
        ) : null}
        {record.updates.length > 0 ? (
          <section>
            <p className={LABEL}>Updates it was sent</p>
            <ul className={LIST}>
              {record.updates.map((update) => (
                <li key={`${update.at}-${update.text}`} className={ITEM}>
                  {update.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}
