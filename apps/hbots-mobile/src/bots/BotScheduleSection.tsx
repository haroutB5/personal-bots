import type { ServerProvider } from "@t3tools/contracts";
import { scheduleTimeChoices } from "@hbots/personal-client/bots/botFormFields";
import { scheduleHelpLine, type ScheduleDraft } from "@hbots/personal-client/bots/botFormModel";
import { StyleSheet, View } from "react-native";

import { BotModelPickFields } from "./BotModelPickFields";
import { Hint, PickerField, SectionCard, SwitchRow } from "./BotFormUi";
import type { OpenSheet } from "./sheetRequest";

export function BotScheduleSection({
  draft,
  onChange,
  providers,
  providerOptions,
  problem,
  modelLabel,
  openSheet,
}: {
  readonly draft: ScheduleDraft;
  readonly onChange: (patch: Partial<ScheduleDraft>) => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  readonly problem: string | null;
  readonly modelLabel: string | null;
  readonly openSheet: OpenSheet;
}) {
  const pickTime = (title: "From" | "To", current: string, apply: (time: string) => void) =>
    openSheet({
      kind: "choice",
      title,
      choices: scheduleTimeChoices(current).map((time) => ({ value: time, label: time })),
      value: current,
      onSelect: apply,
    });
  return (
    <SectionCard accessibilityLabel="Model schedule">
      <SwitchRow
        label="Use a different model at set times"
        detail="Every day, between these times (your laptop's clock), the bot uses this model instead."
        value={draft.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      {draft.enabled ? (
        <>
          <View style={styles.times}>
            <View style={styles.time}>
              <PickerField
                label="From"
                valueLabel={draft.from}
                onPress={() => pickTime("From", draft.from, (from) => onChange({ from }))}
              />
            </View>
            <View style={styles.time}>
              <PickerField
                label="To"
                valueLabel={draft.to}
                onPress={() => pickTime("To", draft.to, (to) => onChange({ to }))}
              />
            </View>
          </View>
          <BotModelPickFields
            labelPrefix="Scheduled"
            draft={draft}
            onChange={onChange}
            providers={providers}
            providerOptions={providerOptions}
            unavailableNote={(label) =>
              `${label} can't run right now, so the bot stays on its own model.`
            }
            openSheet={openSheet}
          />
          {problem === null ? (
            <Hint>{scheduleHelpLine(draft, modelLabel)}</Hint>
          ) : (
            <Hint error>{problem}</Hint>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  times: { flexDirection: "row", gap: 12 },
  time: { flex: 1 },
});
