import { useNavigation } from "@react-navigation/native";
import {
  personalBotTeamLabel,
  PersonalBotId,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";
import {
  BOT_NAME_MAX,
  BOT_TITLE_MAX,
  DELETE_BOT_CONFIRM_LABEL,
  DISCARD_BOT_EDITS_LABEL,
  DISCARD_BOT_EDITS_MESSAGE,
  assessBotDraft,
  botDraftsEqual,
  deleteBotConfirmMessage,
  draftFromBot,
  draftInstructionWarning,
  fallbackDraftOf,
  newBotDraft,
  planBotSave,
  providerOptionsFor,
  scheduleDraftOf,
  selectableProviders as selectableProvidersOf,
  withStartingProvider,
  type BotDraft,
} from "@hbots/personal-client/bots/botDraft";
import {
  currentMuteLabelOf,
  descriptorChoices,
  descriptorValue,
  modelChoices,
  notificationChoices,
  providerChoices,
  voiceCallsLine,
} from "@hbots/personal-client/bots/botFormFields";
import {
  botAgentModeDescriptor,
  botContextWindowDescriptor,
  botEffortDescriptor,
  defaultModelFor,
  noBotProviderMessage,
  usesModelSearch,
} from "@hbots/personal-client/bots/botFormModel";
import { botModelLabel } from "@hbots/personal-client/bots/botModelLabel";
import { resolveBotProvider } from "@hbots/personal-client/bots/botSummaries";
import { dropChatFromSnapshot } from "@hbots/personal-client/bots/chatsSnapshot";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { ChoiceSheet } from "../sheets/ChoiceSheet";
import { ModelSearchSheet } from "../sheets/ModelSearchSheet";
import { BotAvatarPicker } from "./BotAvatarPicker";
import { BotFallbackSection } from "./BotFallbackSection";
import {
  FieldLabel,
  FormButton,
  formStyles,
  Hint,
  InfoRow,
  PickerField,
  SectionCard,
  SwitchRow,
  TextField,
} from "./BotFormUi";
import { BotScheduleSection } from "./BotScheduleSection";
import { InstructionsField } from "./InstructionsField";
import {
  BOT_GONE_MESSAGE,
  BOT_SAVE_FAILED_MESSAGE,
  botFormScreenState,
  botFormTitle,
  botSubmitDecision,
  botTeamChoices,
  type BotFormTarget,
} from "./botFormScreenModel";
import type { OpenSheet, SheetRequest } from "./sheetRequest";

const SKELETON_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ["name", 44],
  ["title", 44],
  ["description", 44],
  ["instructions", 120],
  ["provider", 44],
];

function FormSkeleton() {
  return (
    <View style={formStyles.body} accessibilityLabel="Loading bot" accessibilityRole="progressbar">
      {SKELETON_FIELDS.map(([field, height]) => (
        <View key={field} style={styles.skeletonField}>
          <View style={styles.skeletonLabel} />
          <View style={[styles.skeletonInput, { height }]} />
        </View>
      ))}
    </View>
  );
}

function SheetHost({
  request,
  onClose,
}: {
  readonly request: SheetRequest | null;
  readonly onClose: () => void;
}) {
  if (request === null) return null;
  switch (request.kind) {
    case "choice":
      return (
        <ChoiceSheet
          visible
          title={request.title}
          choices={request.choices}
          value={request.value}
          onSelect={request.onSelect}
          onClose={onClose}
        />
      );
    case "model":
      return (
        <ModelSearchSheet
          visible
          title={request.title}
          models={request.models}
          value={request.value}
          onSelect={request.onSelect}
          onClose={onClose}
        />
      );
    default: {
      const unreachable: never = request;
      return unreachable;
    }
  }
}

function BotForm({
  native,
  bot,
  bots,
  onOpenTeam,
  onLeave,
  onDeleted,
  openSheet,
}: {
  readonly native: NativePersonal;
  readonly bot: PersonalBot | null;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly onOpenTeam: () => void;
  readonly onLeave: () => void;
  readonly onDeleted: () => void;
  readonly openSheet: OpenSheet;
}) {
  const navigation = useNavigation();
  const environmentId = native.environmentId;
  const providers = native.useProviders();
  const profile = native.bots.usePersonalProfile(environmentId);
  const createBot = native.client.useAtomCommand(native.bots.personalBotCreate, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const deleteBot = native.client.useAtomCommand(native.bots.personalBotDelete, {
    reportFailure: false,
  });
  const recheckProvider = native.client.useAtomCommand(native.bots.personalProviderRecheck, {
    reportFailure: false,
  });

  const [botId] = useState(
    () => bot?.botId ?? PersonalBotId.make(native.client.ports.ids.randomUUID()),
  );
  const [busy, setBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const nameInputRef = useRef<TextInput>(null);

  const selectableProviders = useMemo(() => selectableProvidersOf(providers), [providers]);
  const [rawDraft, setDraft] = useState<BotDraft>(() =>
    bot !== null ? draftFromBot(bot, Date.now()) : newBotDraft(selectableProviders),
  );
  const [baseline] = useState(() => rawDraft);
  const [currentMuteLabel] = useState(() => currentMuteLabelOf(bot, Date.now()));
  const dirty = !botDraftsEqual(rawDraft, baseline);

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const leavingRef = useRef(false);
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!dirtyRef.current || leavingRef.current) return;
        event.preventDefault();
        void confirmDestructive(DISCARD_BOT_EDITS_MESSAGE, DISCARD_BOT_EDITS_LABEL).then(
          (discard) => {
            if (!discard) return;
            leavingRef.current = true;
            navigation.dispatch(event.data.action);
          },
        );
      }),
    [navigation],
  );

  const draft: BotDraft = withStartingProvider(rawDraft, bot === null, selectableProviders);
  const providerOptions = useMemo(
    () => providerOptionsFor(draft.instanceId, providers, selectableProviders),
    [draft.instanceId, providers, selectableProviders],
  );
  const selectedProvider = providers.find((provider) => provider.instanceId === draft.instanceId);
  const providerStatus =
    draft.instanceId === "" ? null : resolveBotProvider(draft.instanceId, providers);
  const instructionWarning = draftInstructionWarning(
    providers,
    draft.instanceId,
    providerStatus?.label ?? null,
  );
  const models = selectedProvider?.models ?? [];
  const fallbackProviderOptions = useMemo(
    () => providerOptionsFor(draft.fallbackInstanceId, providers, selectableProviders),
    [draft.fallbackInstanceId, providers, selectableProviders],
  );
  const scheduleProviderOptions = useMemo(
    () => providerOptionsFor(draft.scheduleInstanceId, providers, selectableProviders),
    [draft.scheduleInstanceId, providers, selectableProviders],
  );
  const assessment = assessBotDraft(draft, providers, bot, busy);
  const { scheduleSelection, scheduleProblem, canSave } = assessment;

  const update = (patch: Partial<BotDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    if (patch.name !== undefined && patch.name.trim().length > 0) setNameError(null);
  };

  const effortDescriptor = botEffortDescriptor(selectedProvider, draft.model);
  const contextWindowDescriptor = botContextWindowDescriptor(selectedProvider, draft.model);
  const agentModeDescriptor = botAgentModeDescriptor(selectedProvider, draft.model);
  const providerPicks = providerChoices(providerOptions, providers);
  const modelPicks = modelChoices(models, draft.model);
  const teams = botTeamChoices(profile.data?.customTeams ?? [], bots, bot);
  const notificationPicks = notificationChoices(currentMuteLabel);
  const labelOf = (
    choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
    value: string,
  ) => choices.find((choice) => choice.value === value)?.label ?? value;

  const pickFromDescriptor = (
    title: string,
    descriptor: NonNullable<typeof effortDescriptor>,
    current: string,
    apply: (value: string) => void,
  ) =>
    openSheet({
      kind: "choice",
      title,
      choices: descriptorChoices(descriptor),
      value: descriptorValue(descriptor, current),
      onSelect: apply,
    });

  const submit = async () => {
    const decision = botSubmitDecision({ draft, botId, bots, canSave });
    switch (decision.kind) {
      case "nameProblem":
        setNameError(decision.message);
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        nameInputRef.current?.focus();
        return;
      case "blocked":
        return;
      case "save":
        break;
      default: {
        const unreachable: never = decision;
        return unreachable;
      }
    }
    setNameError(null);
    setSubmitError(null);
    setBusy(true);
    const plan = planBotSave({
      botId,
      saved: bot,
      draft,
      baselineNotifications: baseline.notifications,
      providers,
      assessment,
    });
    let result =
      plan.kind === "create"
        ? await createBot({ environmentId, input: plan.create })
        : await updateBot({ environmentId, input: plan.update });
    if (plan.kind === "create" && plan.followUp !== null && result._tag === "Success") {
      result = await updateBot({ environmentId, input: plan.followUp });
    }
    setBusy(false);
    if (result._tag === "Success") {
      leavingRef.current = true;
      onLeave();
      return;
    }
    setSubmitError(commandFailureMessage(result, BOT_SAVE_FAILED_MESSAGE));
  };

  const remove = async () => {
    if (bot === null) return;
    const confirmed = await confirmDestructive(
      deleteBotConfirmMessage(bot.name),
      DELETE_BOT_CONFIRM_LABEL,
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await deleteBot({ environmentId, input: { botId: bot.botId } });
    setBusy(false);
    const failure = commandFailureMessage(result, `Couldn't delete ${bot.name}. Try again.`);
    if (failure !== null) {
      setSubmitError(failure);
      return;
    }
    dropChatFromSnapshot(native.client.ports.kv, environmentId, (row) => row.botId === bot.botId);
    setSubmitError(null);
    leavingRef.current = true;
    onDeleted();
  };

  const recheck = async () => {
    if (selectedProvider === undefined || rechecking) return;
    setRechecking(true);
    setRecheckError(null);
    const label = providerStatus?.label ?? selectedProvider.instanceId;
    const result = await recheckProvider({
      environmentId,
      input: { instanceId: selectedProvider.instanceId },
    });
    setRechecking(false);
    setRecheckError(commandFailureMessage(result, `Couldn't check ${label}.`));
  };

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={formStyles.body}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <TextField
        label="Name"
        value={draft.name}
        onChange={(name) => update({ name })}
        placeholder="e.g. Researcher"
        maxLength={BOT_NAME_MAX}
        error={nameError}
        inputRef={nameInputRef}
      />
      <TextField
        label="Title"
        optionalNote="(optional)"
        value={draft.title}
        onChange={(title) => update({ title })}
        placeholder="e.g. Research analyst"
        maxLength={BOT_TITLE_MAX}
      />
      <TextField
        label="Description"
        value={draft.description}
        onChange={(description) => update({ description })}
        placeholder="What this bot is for"
      />
      <InstructionsField
        value={draft.instructions}
        onChange={(instructions) => update({ instructions })}
        placeholder="How the bot should work and respond"
      />

      <View style={styles.group}>
        {providerOptions.length === 0 ? (
          <>
            <FieldLabel>Provider</FieldLabel>
            <Text style={styles.plain} maxFontSizeMultiplier={1.6}>
              {noBotProviderMessage(providers)}
            </Text>
          </>
        ) : (
          <PickerField
            label="Provider"
            valueLabel={labelOf(providerPicks, draft.instanceId)}
            onPress={() =>
              openSheet({
                kind: "choice",
                title: "Provider",
                choices: providerPicks,
                value: draft.instanceId,
                onSelect: (instanceId) =>
                  update({
                    instanceId,
                    model: defaultModelFor(
                      providers.find((provider) => provider.instanceId === instanceId),
                    ),
                  }),
              })
            }
          />
        )}
        {providerStatus !== null && !providerStatus.available ? (
          <>
            <Hint>
              {`${providerStatus.label} can't run right now, so this bot can't reply. Pick another provider or fix it on your computer.`}
            </Hint>
            <FormButton
              label={rechecking ? "Checking…" : "Check again"}
              variant="quiet"
              onPress={() => void recheck()}
              disabled={rechecking}
              busy={rechecking}
            />
            {recheckError === null ? null : <Hint error>{recheckError}</Hint>}
          </>
        ) : null}
        {instructionWarning === null ? null : <Hint>{instructionWarning}</Hint>}
      </View>

      {models.length > 0 ? (
        <PickerField
          label="Model"
          valueLabel={labelOf(modelPicks, draft.model)}
          onPress={() =>
            usesModelSearch(models)
              ? openSheet({
                  kind: "model",
                  title: "Model",
                  models,
                  value: draft.model,
                  onSelect: (model) => update({ model }),
                })
              : openSheet({
                  kind: "choice",
                  title: "Model",
                  choices: modelPicks,
                  value: draft.model,
                  onSelect: (model) => update({ model }),
                })
          }
        />
      ) : null}

      {effortDescriptor !== null ? (
        <PickerField
          label="Effort"
          valueLabel={labelOf(
            descriptorChoices(effortDescriptor),
            descriptorValue(effortDescriptor, draft.effort),
          )}
          hint="Higher effort thinks longer and uses more of your plan's limits."
          onPress={() =>
            pickFromDescriptor("Effort", effortDescriptor, draft.effort, (effort) =>
              update({ effort }),
            )
          }
        />
      ) : null}

      {contextWindowDescriptor !== null ? (
        <PickerField
          label="Context window"
          valueLabel={labelOf(
            descriptorChoices(contextWindowDescriptor),
            descriptorValue(contextWindowDescriptor, draft.contextWindow),
          )}
          hint="A bigger window keeps longer chats in memory, but every reply resends it, so long chats use your plan's limits faster."
          onPress={() =>
            pickFromDescriptor(
              "Context window",
              contextWindowDescriptor,
              draft.contextWindow,
              (contextWindow) => update({ contextWindow }),
            )
          }
        />
      ) : null}

      {agentModeDescriptor !== null ? (
        <PickerField
          label="Agent mode"
          valueLabel={labelOf(
            descriptorChoices(agentModeDescriptor),
            descriptorValue(agentModeDescriptor, draft.agentMode),
          )}
          hint="Standard gives the bot every tool. Code has it write small programs that call its tools (tool cards show as code). Minimal gives it a shell and its own tools only, with no skills. The mode is fixed when a chat starts, so a change applies to new chats."
          onPress={() =>
            pickFromDescriptor("Agent mode", agentModeDescriptor, draft.agentMode, (agentMode) =>
              update({ agentMode }),
            )
          }
        />
      ) : null}

      <BotFallbackSection
        draft={fallbackDraftOf(draft)}
        onChange={(patch) =>
          update({
            ...(patch.enabled === undefined ? {} : { fallbackEnabled: patch.enabled }),
            ...(patch.instanceId === undefined ? {} : { fallbackInstanceId: patch.instanceId }),
            ...(patch.model === undefined ? {} : { fallbackModel: patch.model }),
            ...(patch.effort === undefined ? {} : { fallbackEffort: patch.effort }),
            ...(patch.contextWindow === undefined
              ? {}
              : { fallbackContextWindow: patch.contextWindow }),
          })
        }
        providers={providers}
        providerOptions={fallbackProviderOptions}
        main={{ instanceId: draft.instanceId, model: draft.model }}
        openSheet={openSheet}
      />

      <BotScheduleSection
        draft={scheduleDraftOf(draft)}
        onChange={(patch) =>
          update({
            ...(patch.enabled === undefined ? {} : { scheduleEnabled: patch.enabled }),
            ...(patch.from === undefined ? {} : { scheduleFrom: patch.from }),
            ...(patch.to === undefined ? {} : { scheduleTo: patch.to }),
            ...(patch.instanceId === undefined ? {} : { scheduleInstanceId: patch.instanceId }),
            ...(patch.model === undefined ? {} : { scheduleModel: patch.model }),
            ...(patch.effort === undefined ? {} : { scheduleEffort: patch.effort }),
            ...(patch.contextWindow === undefined
              ? {}
              : { scheduleContextWindow: patch.contextWindow }),
          })
        }
        providers={providers}
        providerOptions={scheduleProviderOptions}
        problem={scheduleProblem}
        modelLabel={scheduleSelection === null ? null : botModelLabel(scheduleSelection, providers)}
        openSheet={openSheet}
      />

      <View style={styles.group}>
        <PickerField
          label="Team"
          valueLabel={personalBotTeamLabel(draft.team)}
          hint="A bot hands work to its own team. Reaching another team needs you to name the bot you want in your message."
          onPress={() =>
            openSheet({
              kind: "choice",
              title: "Team",
              choices: teams.map((team) => ({ value: team, label: personalBotTeamLabel(team) })),
              value: draft.team,
              onSelect: (value) => {
                const team: PersonalBotTeam | undefined = teams.find(
                  (candidate) => candidate === value,
                );
                if (team !== undefined) update({ team });
              },
            })
          }
        />
        <Pressable
          onPress={onOpenTeam}
          accessibilityRole="link"
          accessibilityLabel="Manage teams"
          style={formStyles.inlineLink}
        >
          <Text style={styles.manageTeams} maxFontSizeMultiplier={1.6}>
            Manage teams
          </Text>
        </Pressable>
      </View>

      <SwitchRow
        label="Team lead"
        detail="One per team. Making this bot the lead replaces the current one."
        value={draft.lead}
        onChange={(lead) => update({ lead })}
      />
      <SwitchRow
        label="Pin to top"
        detail="Keeps this bot in the Pinned box at the top of Bots."
        value={draft.pinned}
        onChange={(pinned) => update({ pinned })}
      />
      <SwitchRow
        label="Save memories without asking"
        detail={`Keeps what you tell this bot for later chats without you saying "remember", except in a chat that had a sensitive site open.`}
        value={draft.memoryAutoSave}
        onChange={(memoryAutoSave) => update({ memoryAutoSave })}
      />
      <SwitchRow
        label="Hide message previews"
        detail="Keeps this bot's message text out of lists, cards, notifications and banners. It only shows inside the chat."
        value={draft.hidePreviews}
        onChange={(hidePreviews) => update({ hidePreviews })}
      />
      <InfoRow label="Voice calls" detail={voiceCallsLine(draft.lead)} />

      <PickerField
        label="Notifications"
        valueLabel={labelOf(notificationPicks, draft.notifications)}
        hint="A muted bot sends no notifications or banners. Its replies still show in Bots."
        onPress={() =>
          openSheet({
            kind: "choice",
            title: "Notifications",
            choices: notificationPicks,
            value: draft.notifications,
            onSelect: (value) => {
              const choice = notificationPicks.find((candidate) => candidate.value === value);
              if (choice !== undefined) update({ notifications: choice.value });
            },
          })
        }
      />

      <SectionCard accessibilityLabel="Avatar">
        <Text style={styles.legend} maxFontSizeMultiplier={1.6}>
          Avatar
        </Text>
        <BotAvatarPicker
          shape={draft.avatarShape}
          color={draft.avatarColor}
          previewName={draft.name.trim()}
          onChange={(next) => update({ avatarShape: next.shape, avatarColor: next.color })}
        />
      </SectionCard>

      {submitError === null ? null : <Hint error>{submitError}</Hint>}

      <FormButton
        label={bot === null ? "Create bot" : "Save changes"}
        variant="primary"
        onPress={() => void submit()}
        disabled={!canSave}
        busy={busy}
      />
      {bot === null ? null : (
        <FormButton
          label="Delete bot"
          variant="danger"
          onPress={() => void remove()}
          disabled={busy}
        />
      )}
    </ScrollView>
  );
}

export function BotFormScreen({
  native,
  target,
  onBack,
  onLeave,
  onDeleted,
  onOpenTeam,
}: {
  readonly native: NativePersonal;
  readonly target: BotFormTarget;
  readonly onBack: () => void;
  readonly onLeave: () => void;
  readonly onDeleted: () => void;
  readonly onOpenTeam: () => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const bots = list.data?.bots ?? null;
  const state = botFormScreenState(target, { bots, error: list.error });

  const body = (() => {
    switch (state.kind) {
      case "loading":
        return <FormSkeleton />;
      case "notFound":
        return (
          <View style={formStyles.centered}>
            <Text style={formStyles.note}>{BOT_GONE_MESSAGE}</Text>
            <FormButton label="Back" variant="quiet" onPress={onBack} />
          </View>
        );
      case "error":
        return (
          <View style={formStyles.centered}>
            <Text style={formStyles.note}>{state.message}</Text>
            <FormButton label="Try again" variant="quiet" onPress={list.refresh} />
          </View>
        );
      case "ready":
        return (
          <BotForm
            key={state.bot?.botId ?? "new"}
            native={native}
            bot={state.bot}
            bots={bots ?? []}
            onOpenTeam={onOpenTeam}
            onLeave={onLeave}
            onDeleted={onDeleted}
            openSheet={setSheet}
          />
        );
      default: {
        const unreachable: never = state;
        return unreachable;
      }
    }
  })();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={botFormTitle(state, target)} onBack={onBack} />
      {body}
      <SheetHost request={sheet} onClose={() => setSheet(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  group: { gap: 6 },
  plain: { color: tokens.textSecondary, fontSize: 15 },
  manageTeams: { color: tokens.primary, fontSize: 14 },
  legend: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  skeletonField: { gap: 8 },
  skeletonLabel: { width: 96, height: 14, borderRadius: 7, backgroundColor: tokens.fillMuted },
  skeletonInput: { borderRadius: 12, backgroundColor: tokens.fillMuted },
});
