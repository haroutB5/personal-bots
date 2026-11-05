import type { ServerProvider } from "@t3tools/contracts";
import {
  descriptorChoices,
  descriptorValue,
  modelChoices,
  providerChoices,
} from "@hbots/personal-client/bots/botFormFields";
import {
  botContextWindowDescriptor,
  botEffortDescriptor,
  defaultModelFor,
  type ModelDraft,
  usesModelSearch,
} from "@hbots/personal-client/bots/botFormModel";
import { resolveBotProvider } from "@hbots/personal-client/bots/botSummaries";
import type { ReactNode } from "react";

import { Hint, PickerField } from "./BotFormUi";
import type { OpenSheet } from "./sheetRequest";

type PickDraft = Pick<ModelDraft, "instanceId" | "model" | "effort" | "contextWindow">;

function labelOf(
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string,
): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

export function BotModelPickFields({
  labelPrefix,
  draft,
  onChange,
  providers,
  providerOptions,
  unavailableNote,
  modelNote,
  openSheet,
}: {
  readonly labelPrefix: string;
  readonly draft: PickDraft;
  readonly onChange: (patch: Partial<PickDraft>) => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  readonly unavailableNote: (providerLabel: string) => string;
  readonly modelNote?: ReactNode;
  readonly openSheet: OpenSheet;
}) {
  const provider = providers.find((candidate) => candidate.instanceId === draft.instanceId);
  const providerStatus =
    draft.instanceId === "" ? null : resolveBotProvider(draft.instanceId, providers);
  const models = provider?.models ?? [];
  const effortDescriptor = botEffortDescriptor(provider, draft.model);
  const contextDescriptor = botContextWindowDescriptor(provider, draft.model);
  const providerPicks = providerChoices(providerOptions, providers);
  const modelPicks = modelChoices(models, draft.model);

  return (
    <>
      <PickerField
        label={`${labelPrefix} provider`}
        valueLabel={
          draft.instanceId === "" ? "Pick a provider" : labelOf(providerPicks, draft.instanceId)
        }
        onPress={() =>
          openSheet({
            kind: "choice",
            title: `${labelPrefix} provider`,
            choices: providerPicks,
            value: draft.instanceId,
            onSelect: (instanceId) =>
              onChange({
                instanceId,
                model: defaultModelFor(providers.find((c) => c.instanceId === instanceId)),
                effort: "",
                contextWindow: "",
              }),
          })
        }
        {...(providerStatus !== null && !providerStatus.available
          ? { hint: unavailableNote(providerStatus.label) }
          : {})}
      />

      {models.length > 0 ? (
        <>
          <PickerField
            label={`${labelPrefix} model`}
            valueLabel={labelOf(modelPicks, draft.model)}
            onPress={() =>
              usesModelSearch(models)
                ? openSheet({
                    kind: "model",
                    title: `${labelPrefix} model`,
                    models,
                    value: draft.model,
                    onSelect: (model) => onChange({ model }),
                  })
                : openSheet({
                    kind: "choice",
                    title: `${labelPrefix} model`,
                    choices: modelPicks,
                    value: draft.model,
                    onSelect: (model) => onChange({ model }),
                  })
            }
          />
          {modelNote}
        </>
      ) : (
        <Hint>
          {draft.model === ""
            ? "This provider lists no models yet."
            : `${labelPrefix} model: ${draft.model}`}
        </Hint>
      )}

      {effortDescriptor !== null ? (
        <PickerField
          label={`${labelPrefix} effort`}
          valueLabel={labelOf(
            descriptorChoices(effortDescriptor),
            descriptorValue(effortDescriptor, draft.effort),
          )}
          onPress={() =>
            openSheet({
              kind: "choice",
              title: `${labelPrefix} effort`,
              choices: descriptorChoices(effortDescriptor),
              value: descriptorValue(effortDescriptor, draft.effort),
              onSelect: (effort) => onChange({ effort }),
            })
          }
        />
      ) : null}

      {contextDescriptor !== null ? (
        <PickerField
          label={`${labelPrefix} context window`}
          valueLabel={labelOf(
            descriptorChoices(contextDescriptor),
            descriptorValue(contextDescriptor, draft.contextWindow),
          )}
          onPress={() =>
            openSheet({
              kind: "choice",
              title: `${labelPrefix} context window`,
              choices: descriptorChoices(contextDescriptor),
              value: descriptorValue(contextDescriptor, draft.contextWindow),
              onSelect: (contextWindow) => onChange({ contextWindow }),
            })
          }
        />
      ) : null}
    </>
  );
}
