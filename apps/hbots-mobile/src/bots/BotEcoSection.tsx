import type { ServerProvider } from "@t3tools/contracts";
import { type EcoDraft, ecoDraftProblem } from "@hbots/personal-client/bots/botFormModel";

import { BotModelPickFields } from "./BotModelPickFields";
import { Hint, SectionCard, SwitchRow } from "./BotFormUi";
import type { OpenSheet } from "./sheetRequest";

/**
 * Eco mode: on delegated tasks and routine runs the bot's own model plans
 * and a cheaper builder on the same provider writes the code.
 */
export function BotEcoSection({
  draft,
  onChange,
  providers,
  main,
  openSheet,
}: {
  readonly draft: EcoDraft;
  readonly onChange: (patch: Partial<EcoDraft>) => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly main: { readonly instanceId: string; readonly model: string };
  readonly openSheet: OpenSheet;
}) {
  const problem = ecoDraftProblem(main, draft, providers);
  return (
    <SectionCard accessibilityLabel="Eco mode">
      <SwitchRow
        label="Eco mode"
        detail="On tasks and routines, this model investigates and plans, then a cheaper model writes and tests the code. Chats always use this model."
        value={draft.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      {draft.enabled ? (
        <BotModelPickFields
          labelPrefix="Builder"
          draft={draft}
          onChange={onChange}
          providers={providers}
          providerOptions={[]}
          fixedProvider
          unavailableNote={(label) => `${label} can't run right now.`}
          modelNote={problem === null ? null : <Hint>{problem}</Hint>}
          openSheet={openSheet}
        />
      ) : null}
    </SectionCard>
  );
}
