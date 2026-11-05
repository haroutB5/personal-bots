import type { ServerProvider } from "@t3tools/contracts";
import {
  type FallbackDraft,
  sameFamilyFallbackHint,
} from "@hbots/personal-client/bots/botFormModel";

import { BotModelPickFields } from "./BotModelPickFields";
import { Hint, SectionCard, SwitchRow } from "./BotFormUi";
import type { OpenSheet } from "./sheetRequest";

export function BotFallbackSection({
  draft,
  onChange,
  providers,
  providerOptions,
  main,
  openSheet,
}: {
  readonly draft: FallbackDraft;
  readonly onChange: (patch: Partial<FallbackDraft>) => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  readonly main: { readonly instanceId: string; readonly model: string };
  readonly openSheet: OpenSheet;
}) {
  const sameFamilyHint = draft.enabled ? sameFamilyFallbackHint(main, draft) : null;
  return (
    <SectionCard accessibilityLabel="Usage limit fallback">
      <SwitchRow
        label="Switch model when the usage limit is hit"
        detail="The bot keeps replying on this model until its own limit resets, then goes back."
        value={draft.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      {draft.enabled ? (
        <BotModelPickFields
          labelPrefix="Fallback"
          draft={draft}
          onChange={onChange}
          providers={providers}
          providerOptions={providerOptions}
          unavailableNote={(label) =>
            `${label} can't run right now, so the bot can't switch to it.`
          }
          modelNote={sameFamilyHint === null ? null : <Hint>{sameFamilyHint}</Hint>}
          openSheet={openSheet}
        />
      ) : null}
    </SectionCard>
  );
}
