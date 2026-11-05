import type {
  EnvironmentId,
  PersonalMemoryEntry,
  PersonalMemoryTidyChange,
  PersonalMemoryTidyLogResult,
} from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  appScopeChip,
  memoryMetaLine,
  memorySourceLabel,
  plainMemoryText,
  rulesUsageCardModel,
  TIDY_ACTION_LABEL,
  TIDY_CHANGE_STATUS_LABEL,
  TIDY_MODE_LABEL,
  TIDY_MODES,
  tidyRunKindLabel,
  tidyStatusLabel,
} from "@hbots/personal-client/memory/memoryPresentation";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecureScreen } from "../platform/secureScreen";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { memoryEmptyLine, memorySections } from "./memoryScreenModel";
import { Notice, PrimaryButton, SectionNote, TextButton } from "./SettingsUi";

const PAGE = 100;

export function MemoryScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId as EnvironmentId;
  useSecureScreen(true);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<ReadonlyArray<string>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [rulesLimit, setRulesLimit] = useState(2000);
  const [notesLimit, setNotesLimit] = useState(PAGE);
  const [summaryLimit, setSummaryLimit] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const rules = native.memory.usePersonalMemoryList(environmentId, {
    kind: "preference",
    query: debounced,
    limit: rulesLimit,
  });
  const notes = native.memory.usePersonalMemoryList(environmentId, {
    kind: "note",
    query: debounced,
    limit: notesLimit,
  });
  const summaries = native.memory.usePersonalMemoryList(environmentId, {
    kind: "task_summary",
    query: debounced,
    limit: summaryLimit,
  });
  const archived = native.memory.usePersonalMemoryList(environmentId, {
    replaced: true,
    query: debounced,
    limit: PAGE,
  });
  const usage = native.memory.usePersonalMemoryRulesUsage(environmentId);
  const tidyLog = native.memory.usePersonalMemoryTidyLog(environmentId);
  const bots = native.bots.usePersonalBotsList(environmentId);
  const deleteOne = native.memory.personalMemoryDelete;
  const deleteMany = native.memory.personalMemoryDeleteMany;
  const restore = native.memory.personalMemoryRestore;
  const tidySetMode = native.memory.personalMemoryTidySetMode;
  const tidyRun = native.memory.personalMemoryTidyRun;
  const tidyDecide = native.memory.personalMemoryTidyDecide;
  const tidyUndo = native.memory.personalMemoryTidyUndo;
  const runDelete = native.client.useAtomCommand(deleteOne, { reportFailure: false });
  const runDeleteMany = native.client.useAtomCommand(deleteMany, { reportFailure: false });
  const runRestore = native.client.useAtomCommand(restore, { reportFailure: false });
  const runSetMode = native.client.useAtomCommand(tidySetMode, { reportFailure: false });
  const runTidy = native.client.useAtomCommand(tidyRun, { reportFailure: false });
  const runDecide = native.client.useAtomCommand(tidyDecide, { reportFailure: false });
  const runUndo = native.client.useAtomCommand(tidyUndo, { reportFailure: false });

  const botName = useMemo(() => {
    const map = new Map((bots.data?.bots ?? []).map((bot) => [String(bot.botId), bot.name]));
    return (botId: string) => map.get(botId);
  }, [bots.data?.bots]);

  const ruleEntries = rules.data?.entries ?? [];
  const noteEntries = notes.data?.entries ?? [];
  const summaryEntries = summaries.data?.entries ?? [];
  const visible = [...ruleEntries, ...noteEntries, ...summaryEntries];
  const loading =
    rules.data === null && notes.data === null && summaries.data === null
      ? (rules.error ?? notes.error ?? summaries.error ?? "Loading…")
      : null;
  const emptyLine = memoryEmptyLine({
    search: debounced,
    visible: visible.length,
    totals: {
      rules: rules.data?.total ?? 0,
      notes: notes.data?.total ?? 0,
      summaries: summaries.data?.total ?? 0,
    },
  });
  const sections = memorySections({
    rules: ruleEntries,
    ruleTotal: rules.data?.total,
    notes: noteEntries,
    noteTotal: notes.data?.total,
    summaries: summaryEntries,
    summaryTotal: summaries.data?.total,
  });
  const pendingChanges = (tidyLog.data?.runs ?? [])
    .flatMap((run) => run.changes)
    .filter((change) => change.status === "pending");
  const usageModel = usage.data === null ? null : rulesUsageCardModel(usage.data);

  const toggleChosen = (id: string) => {
    setChosen((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const confirmDelete = (entry: PersonalMemoryEntry) => {
    Alert.alert(
      "Delete this memory?",
      "Bots stop receiving it. Chats that mention it still contain the text.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete memory",
          style: "destructive",
          onPress: () => {
            void (async () => {
              const result = await runDelete({
                environmentId,
                input: { memoryId: entry.memoryId },
              });
              const failure = commandFailureMessage(result, "Could not delete that memory.");
              if (failure !== null) setError(failure);
              else setNotice("Deleted 1 memory.");
            })();
          },
        },
      ],
    );
  };

  const confirmBulk = () => {
    if (chosen.length === 0) return;
    Alert.alert(
      `Delete ${chosen.length === 1 ? "1 memory" : `${chosen.length} memories`}?`,
      `Bots stop receiving ${chosen.length === 1 ? "it" : "them"}. Chats where ${chosen.length === 1 ? "it was" : "they were"} mentioned still contain the text.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Delete ${chosen.length === 1 ? "1 memory" : `${chosen.length} memories`}`,
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              const result = await runDeleteMany({
                environmentId,
                input: { memoryIds: chosen.slice(0, 500) as never },
              });
              const failure = commandFailureMessage(result, "Could not delete those memories.");
              if (failure !== null) {
                setError(failure);
              } else {
                setNotice(`Deleted ${chosen.length} memories.`);
                setChosen([]);
                setSelecting(false);
              }
              setBusy(false);
            })();
          },
        },
      ],
    );
  };

  const decide = async (change: PersonalMemoryTidyChange, approve: boolean) => {
    setBusy(true);
    const result = await runDecide({
      environmentId,
      input: { changeId: change.changeId, approve, changeHash: change.changeHash },
    });
    const failure = commandFailureMessage(
      result,
      approve ? "Could not approve that change." : "Could not reject that change.",
    );
    if (failure !== null) setError(failure);
    else setNotice(approve ? "Approved." : "Rejected.");
    setBusy(false);
  };

  const undo = async (change: PersonalMemoryTidyChange) => {
    setBusy(true);
    const result = await runUndo({
      environmentId,
      input: { changeId: change.changeId, changeHash: change.changeHash },
    });
    const failure = commandFailureMessage(result, "Could not undo that change.");
    if (failure !== null) setError(failure);
    else setNotice("Undone.");
    setBusy(false);
  };

  const restoreEntry = async (entry: PersonalMemoryEntry) => {
    const result = await runRestore({ environmentId, input: { memoryId: entry.memoryId } });
    const failure = commandFailureMessage(result, "Could not restore that memory.");
    if (failure !== null) setError(failure);
    else setNotice("Restored. Bots receive it again.");
  };

  const rowFor = (entry: PersonalMemoryEntry) => {
    const text = plainMemoryText(entry.content);
    const isOpen = expanded.includes(String(entry.memoryId));
    const chip = appScopeChip(entry);
    return (
      <Pressable
        key={entry.memoryId}
        onLongPress={() => {
          setSelecting(true);
          setChosen([String(entry.memoryId)]);
        }}
        onPress={() => (selecting ? toggleChosen(String(entry.memoryId)) : undefined)}
        accessibilityRole={selecting ? "checkbox" : "text"}
        accessibilityState={selecting ? { checked: chosen.includes(String(entry.memoryId)) } : {}}
        accessibilityLabel={text}
        style={styles.memoryRow}
      >
        <View style={styles.memoryHead}>
          <Text style={styles.scope} maxFontSizeMultiplier={1.3}>
            {scopeLabel(entry)}
          </Text>
          <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
            {memoryMetaLine(
              memorySourceLabel(entry, botName, () => undefined),
              DateTime.toEpochMillis(entry.updatedAt),
              Date.now(),
            )}
          </Text>
        </View>
        {chip === null ? null : (
          <Text style={styles.chip} maxFontSizeMultiplier={1.3}>
            {chip}
          </Text>
        )}
        <Text
          style={styles.content}
          numberOfLines={isOpen ? undefined : 5}
          maxFontSizeMultiplier={1.5}
        >
          {text}
        </Text>
        <View style={styles.memoryActions}>
          {text.length > 280 ? (
            <TextButton
              label={isOpen ? "Show less" : "Show more"}
              onPress={() => toggleExpanded(String(entry.memoryId))}
            />
          ) : null}
          {selecting ? (
            <Text style={styles.check}>{chosen.includes(String(entry.memoryId)) ? "☑" : "☐"}</Text>
          ) : (
            <TextButton label="Delete" onPress={() => confirmDelete(entry)} destructive />
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {selecting ? (
        <View style={styles.selectHeader}>
          <TextButton
            label="Cancel"
            onPress={() => {
              setSelecting(false);
              setChosen([]);
            }}
          />
          <Text style={styles.selectTitle}>
            {chosen.length === 0 ? "Select memories" : `${chosen.length} selected`}
          </Text>
          <TextButton
            label={
              chosen.length === visible.length && visible.length > 0 ? "Deselect all" : "Select all"
            }
            onPress={() =>
              setChosen(
                chosen.length === visible.length
                  ? []
                  : visible.map((entry) => String(entry.memoryId)),
              )
            }
          />
        </View>
      ) : (
        <ScreenHeader title="Memory" onBack={onBack} />
      )}
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}>
        {selecting ? null : (
          <>
            <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
              What bots remember. Rules go to every turn of the bots they reach; a rule limited to
              one app is listed only in chats about that app. Up to 6 notes and 6 task summaries are
              picked by relevance. A newer entry replaces an older one, which moves to Archived and
              can be restored.
            </Text>
            {usageModel === null ? null : (
              <View style={styles.card}>
                <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                  {usageModel.headline}
                </Text>
                <Text style={styles.cardText} maxFontSizeMultiplier={1.5}>
                  {usageModel.detail}
                </Text>
                {usageModel.rows.map((row) => (
                  <View key={row.key} style={styles.usageRow}>
                    <Text style={styles.cardText} maxFontSizeMultiplier={1.4}>
                      {row.label}
                    </Text>
                    <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                      {row.line}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search memory"
          placeholderTextColor={tokens.textTertiary}
          accessibilityLabel="Search memory"
          style={styles.search}
        />
        {error === null ? null : <Notice tone="danger">{error}</Notice>}
        {notice === null ? null : <Notice tone="success">{notice}</Notice>}
        {loading === null ? null : <SectionNote>{loading}</SectionNote>}
        {emptyLine === null ? null : <SectionNote>{emptyLine}</SectionNote>}

        {ruleEntries.length + noteEntries.length + summaryEntries.length === 0 ? null : (
          <>
            {sections.map((section) => (
              <MemorySection
                key={section.title}
                title={section.heading}
                hint={section.hint}
                entries={section.entries}
                total={section.total}
                showMore={section.showMore}
                onShowMore={() => {
                  if (section.title === "Rules") setRulesLimit(rulesLimit + 100);
                  else if (section.title === "Notes") setNotesLimit(notesLimit + 100);
                  else setSummaryLimit(summaryLimit + 100);
                }}
                rowFor={rowFor}
              />
            ))}
          </>
        )}

        {selecting ? null : (
          <>
            {pendingChanges.length === 0 ? null : (
              <View style={styles.card}>
                <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                  Waiting for your OK ({pendingChanges.length})
                </Text>
                <Text style={styles.cardText} maxFontSizeMultiplier={1.5}>
                  Rules and changes bots asked for. Nothing changes until you approve it.
                </Text>
                {pendingChanges.map((change) => (
                  <View key={change.changeId} style={styles.change}>
                    <Text style={styles.changeTitle} maxFontSizeMultiplier={1.4}>
                      {TIDY_ACTION_LABEL[change.action]} · {TIDY_CHANGE_STATUS_LABEL[change.status]}
                    </Text>
                    {change.content === undefined ? null : (
                      <Text style={styles.cardText} numberOfLines={4} maxFontSizeMultiplier={1.5}>
                        {change.content}
                      </Text>
                    )}
                    {change.reason === undefined ? null : (
                      <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                        {change.reason}
                      </Text>
                    )}
                    <View style={styles.changeButtons}>
                      <TextButton
                        label="Approve"
                        onPress={() => void decide(change, true)}
                        disabled={busy}
                      />
                      <TextButton
                        label="Reject"
                        onPress={() => void decide(change, false)}
                        destructive
                        disabled={busy}
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Pressable
              onPress={() => setTidyOpen(!tidyOpen)}
              accessibilityRole="button"
              style={styles.disclosure}
            >
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                Nightly tidy-up
              </Text>
              <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                {tidySummary(tidyLog.data)}
              </Text>
            </Pressable>
            {tidyOpen ? (
              <View style={styles.card}>
                <Text style={styles.cardText} maxFontSizeMultiplier={1.5}>
                  Each night at 03:30 duplicates are merged and outdated entries are replaced. The
                  changes are made at once, and each one is in the changelog below with an Undo.
                  Preview only lists what it would do and changes nothing.
                </Text>
                <View style={styles.modes}>
                  {TIDY_MODES.map((mode) => (
                    <Pressable
                      key={mode}
                      onPress={() => {
                        void runSetMode({ environmentId, input: { mode } }).then((result) => {
                          const failure = commandFailureMessage(
                            result,
                            "Could not change the tidy-up setting.",
                          );
                          if (failure !== null) setError(failure);
                        });
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: tidyLog.data?.mode === mode }}
                      style={[
                        styles.mode,
                        tidyLog.data?.mode === mode ? styles.modeSelected : null,
                      ]}
                    >
                      <Text style={styles.modeLabel} maxFontSizeMultiplier={1.3}>
                        {TIDY_MODE_LABEL[mode]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <TextButton
                  label="Preview now"
                  onPress={() => {
                    void runTidy({ environmentId, input: { dryRun: true } }).then((result) => {
                      const failure = commandFailureMessage(result, "Could not run the preview.");
                      if (failure !== null) setError(failure);
                    });
                  }}
                />
                <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                  Changelog
                </Text>
                {(tidyLog.data?.runs ?? []).length === 0 ? (
                  <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                    No runs yet.
                  </Text>
                ) : (
                  (tidyLog.data?.runs ?? []).slice(0, 5).map((run) => (
                    <View key={run.runId} style={styles.change}>
                      <Text style={styles.cardText} maxFontSizeMultiplier={1.4}>
                        {tidyRunKindLabel(run)} · {tidyStatusLabel(run.status)}
                      </Text>
                      {run.changes.map((change) => (
                        <View key={change.changeId} style={styles.changeRow}>
                          <Text style={styles.meta} numberOfLines={3} maxFontSizeMultiplier={1.4}>
                            {TIDY_ACTION_LABEL[change.action]} ·{" "}
                            {TIDY_CHANGE_STATUS_LABEL[change.status]}
                          </Text>
                          {change.undoable === true ? (
                            <TextButton
                              label="Undo"
                              onPress={() => void undo(change)}
                              disabled={busy}
                            />
                          ) : null}
                        </View>
                      ))}
                    </View>
                  ))
                )}
              </View>
            ) : null}

            <Pressable
              onPress={() => setArchivedOpen(!archivedOpen)}
              accessibilityRole="button"
              style={styles.disclosure}
            >
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                Archived ({archived.data === null ? "…" : (archived.data.total ?? 0)})
              </Text>
            </Pressable>
            {archivedOpen ? (
              <View style={styles.card}>
                {archived.data === null ? (
                  <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                    {archived.error ?? "Loading…"}
                  </Text>
                ) : (archived.data.entries ?? []).length === 0 ? (
                  <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                    {debounced.length > 0
                      ? "No archived memory matches that search."
                      : "Nothing archived. When a fact changes, or a bot is asked to forget something, the older entry moves here."}
                  </Text>
                ) : (
                  (archived.data.entries ?? []).map((entry) => (
                    <View key={entry.memoryId} style={styles.change}>
                      <Text style={styles.cardText} numberOfLines={3} maxFontSizeMultiplier={1.5}>
                        {plainMemoryText(entry.content)}
                      </Text>
                      <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                        {entry.supersededReason?.trim() || "Archived"}
                      </Text>
                      <TextButton label="Restore" onPress={() => void restoreEntry(entry)} />
                    </View>
                  ))
                )}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      {selecting ? (
        <View style={[styles.selectBar, { paddingBottom: insets.bottom }]}>
          <PrimaryButton
            label={
              chosen.length === 0
                ? "Delete"
                : `Delete ${chosen.length} ${chosen.length === 1 ? "memory" : "memories"}`
            }
            onPress={confirmBulk}
            disabled={chosen.length === 0}
            busy={busy}
            destructive
          />
        </View>
      ) : null}
    </View>
  );
}

function MemorySection({
  title,
  hint,
  entries,
  total,
  showMore,
  onShowMore,
  rowFor,
}: {
  readonly title: string;
  readonly hint: string;
  readonly entries: ReadonlyArray<PersonalMemoryEntry>;
  readonly total: number | undefined;
  readonly showMore: boolean;
  readonly onShowMore: () => void;
  readonly rowFor: (entry: PersonalMemoryEntry) => React.ReactNode;
}) {
  if (entries.length === 0) return null;
  return (
    <View>
      <Text style={styles.sectionTitle} maxFontSizeMultiplier={1.4}>
        {title}
      </Text>
      <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
        {hint}
      </Text>
      <View style={styles.card}>{entries.map(rowFor)}</View>
      {showMore ? (
        <TextButton
          label={`Show more (${entries.length} of ${total ?? entries.length})`}
          onPress={onShowMore}
        />
      ) : null}
    </View>
  );
}

function scopeLabel(entry: PersonalMemoryEntry): string {
  switch (entry.scope) {
    case "shared":
      return "All bots";
    case "project":
      return "Project";
    case "team":
      return "One team";
    case "bot":
      return "One bot";
  }
}

function tidySummary(log: PersonalMemoryTidyLogResult | null): string {
  if (log === null) return "Loading…";
  const last = log.runs[0];
  if (last === undefined) return `${TIDY_MODE_LABEL[log.mode]} · not run yet`;
  return `${TIDY_MODE_LABEL[log.mode]} · last run ${tidyStatusLabel(last.status)}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 10 },
  intro: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  search: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontSize: 15,
    paddingHorizontal: 12,
  },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 14,
    gap: 8,
  },
  cardTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  cardText: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20 },
  meta: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  sectionTitle: { color: tokens.sectionLabel, fontSize: 13, fontWeight: "600", marginTop: 8 },
  memoryRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingVertical: 12,
    gap: 4,
  },
  memoryHead: { gap: 2 },
  scope: { color: tokens.text, fontSize: 13, fontWeight: "600" },
  chip: { color: tokens.textSecondary, fontSize: 12 },
  content: { color: tokens.text, fontSize: 14, lineHeight: 20 },
  memoryActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  check: { color: tokens.text, fontSize: 20 },
  usageRow: { gap: 2 },
  change: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
    gap: 4,
  },
  changeTitle: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  changeButtons: { flexDirection: "row", justifyContent: "flex-end" },
  changeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  disclosure: {
    minHeight: 48,
    justifyContent: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
  },
  modes: { flexDirection: "row", gap: 8 },
  mode: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  modeSelected: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  modeLabel: { color: tokens.textSecondary, fontSize: 12, fontWeight: "500" },
  selectHeader: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
    paddingHorizontal: 4,
  },
  selectTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  selectBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: tokens.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 4,
  },
});
