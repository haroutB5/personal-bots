import type { PersonalMemoryFeedbackSignal, PersonalMemoryTurnContext } from "@t3tools/contracts";
import {
  appChipLabel,
  contextUsedSummary,
  feedbackLabel,
  nextFeedback,
  noteKindLabel,
  rulesHeadline,
} from "@hbots/personal-client/feed/contextUsed";
import { appsLabel, plainMemoryText } from "@hbots/personal-client/memory/presentation";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

function ContextBody({
  context,
  marks,
  busyId,
  onMark,
}: {
  readonly context: PersonalMemoryTurnContext;
  readonly marks: ReadonlyMap<string, PersonalMemoryFeedbackSignal | null>;
  readonly busyId: string | null;
  readonly onMark: (memoryId: string, signal: PersonalMemoryFeedbackSignal) => void;
}) {
  const markOf = (memoryId: string, held: PersonalMemoryFeedbackSignal | null) =>
    marks.has(memoryId) ? (marks.get(memoryId) ?? null) : held;
  return (
    <View>
      {context.apps.length > 0 ? (
        <View>
          <Text style={styles.label}>About</Text>
          <View style={styles.chips}>
            {context.apps.map((app) => (
              <Text key={app.slug} style={styles.chip}>
                {appChipLabel(app)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      <Text style={styles.label}>Rules</Text>
      <Text style={styles.body}>
        {rulesHeadline(context.rules)}
        {context.rules.added.length > 0
          ? ` ${context.rules.added.length} ${
              context.rules.added.length === 1 ? "rule was" : "rules were"
            } added because the chat started covering another app.`
          : ""}
      </Text>
      {context.rules.items.map((rule) => (
        <View key={rule.memoryId} style={styles.rule}>
          <Text style={styles.body}>
            {rule.current
              ? plainMemoryText(rule.content)
              : "(replaced or forgotten since this turn)"}
          </Text>
          <Text style={styles.provenance}>{rule.provenance}</Text>
          {rule.apps !== null && rule.apps.length > 0 ? (
            <Text style={styles.provenance}>Only: {appsLabel(rule.apps)}</Text>
          ) : null}
        </View>
      ))}
      {context.rules.index === null ? null : (
        <Text style={styles.provenance}>
          Not listed, for other apps: {context.rules.index}. The bot can read them with
          search_memory.
        </Text>
      )}
      {context.rules.leftOut.length > 0 ? (
        <View>
          <Text style={styles.bodyStrong}>Did not fit the limit, named to the bot:</Text>
          {context.rules.leftOut.map((rule) => (
            <Text key={rule.memoryId} style={styles.secondary}>
              {plainMemoryText(rule.content)}
            </Text>
          ))}
        </View>
      ) : null}

      <Text style={styles.label}>Notes and task summaries</Text>
      {context.notes.length === 0 ? (
        <Text style={styles.secondary}>None matched this turn.</Text>
      ) : (
        context.notes.map((note) => {
          const mark = markOf(note.memoryId, note.feedback);
          const busy = busyId === note.memoryId;
          return (
            <View key={note.memoryId} style={styles.note}>
              <Text style={styles.noteMeta}>
                <Text style={{ color: tokens.text, fontWeight: "600" }}>
                  {noteKindLabel(note.kind)}
                </Text>
                {mark === null ? "" : ` · ${feedbackLabel(mark)}`}
                {note.current ? "" : " · replaced or forgotten since"}
              </Text>
              <Text style={styles.body}>{plainMemoryText(note.snippet)}</Text>
              <Text style={styles.provenance}>{note.provenance}</Text>
              <View style={styles.chips}>
                {(note.why.length > 0 ? note.why : ["matched words"]).map((reason) => (
                  <Text key={reason} style={styles.chip}>
                    {reason}
                  </Text>
                ))}
              </View>
              {note.current ? (
                <View style={styles.markRow}>
                  {(["outdated", "not_relevant"] as const).map((signal) => (
                    <Pressable
                      key={signal}
                      accessibilityRole="button"
                      accessibilityState={{ selected: mark === signal }}
                      disabled={busy}
                      onPress={() => onMark(note.memoryId, nextFeedback(mark, signal) as never)}
                      style={[
                        styles.mark,
                        mark === signal ? styles.markOn : null,
                        busy ? { opacity: 0.4 } : null,
                      ]}
                    >
                      <Text style={styles.markText}>
                        {signal === "outdated" ? "Outdated" : "Not relevant"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })
      )}

      {context.leftOut.length > 0 ? (
        <View>
          <Text style={styles.label}>Left out</Text>
          {context.leftOut.map((entry) => (
            <Text key={entry.memoryId} style={styles.secondary}>
              {plainMemoryText(entry.snippet)} · {noteKindLabel(entry.kind)} · {entry.reason}
            </Text>
          ))}
        </View>
      ) : null}

      {context.query.terms.length > 0 ? (
        <Text style={styles.provenance}>
          {context.query.followUp
            ? "Your message said little, so the chat's topic led the search: "
            : "Searched for: "}
          {context.query.terms.join(", ")}.
        </Text>
      ) : null}

      <Text style={styles.footer}>
        Outdated stops automatic use; Not relevant ranks a note lower. Nothing is deleted.
      </Text>
    </View>
  );
}

/**
 * One turn's memory, in a bottom sheet: which rules applied and why, which
 * notes matched, what was left out, and the two marks that rank a note lower.
 */
export function ContextUsedSheet({
  native,
  visible,
  threadId,
  messageId,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly onClose: () => void;
}) {
  const turn = native.bots.usePersonalMemoryTurnContext(
    native.environmentId,
    visible && messageId !== null ? { threadId, messageId } : null,
  );
  const feedback = native.client.useAtomCommand(native.bots.personalMemoryFeedback, {
    reportFailure: false,
  });
  const [marks, setMarks] = useState<ReadonlyMap<string, PersonalMemoryFeedbackSignal | null>>(
    () => new Map(),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onMark = async (memoryId: string, signal: PersonalMemoryFeedbackSignal) => {
    if (busyId !== null || native.environmentId === null) return;
    setBusyId(memoryId);
    setError(null);
    const result = await feedback({
      environmentId: native.environmentId,
      input: { memoryId: memoryId as never, signal },
    });
    setBusyId(null);
    if (result._tag !== "Success") {
      setError("Could not save that mark.");
      return;
    }
    setMarks((current) => new Map(current).set(memoryId, signal));
  };

  const context = turn.data ?? null;
  return (
    <SheetShell
      visible={visible}
      title={context === null ? "Context used" : `Context used · ${contextUsedSummary(context)}`}
      onClose={onClose}
    >
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 16 }}>
        {context === null ? (
          <Text style={styles.secondary}>
            {turn.error !== null
              ? turn.error
              : turn.isPending
                ? "Loading…"
                : "No memory was recorded for this turn (none was given, or it is older than 14 days)."}
          </Text>
        ) : (
          <ContextBody
            context={context}
            marks={marks}
            busyId={busyId}
            onMark={(id, signal) => void onMark(id, signal)}
          />
        )}
        {error === null ? null : <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  label: {
    marginTop: 12,
    marginBottom: 4,
    color: tokens.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  body: {
    color: tokens.text,
    fontSize: 14,
    lineHeight: 20,
  },
  bodyStrong: {
    marginTop: 4,
    color: tokens.text,
    fontSize: 13,
    fontWeight: "500",
  },
  secondary: {
    marginTop: 4,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  provenance: {
    marginTop: 2,
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 16,
  },
  chips: {
    marginTop: 4,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    borderRadius: 999,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 8,
    paddingVertical: 2,
    color: tokens.textSecondary,
    fontSize: 12,
  },
  rule: {
    marginTop: 6,
    borderLeftWidth: 2,
    borderLeftColor: tokens.border,
    paddingLeft: 8,
  },
  note: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteMeta: {
    color: tokens.textSecondary,
    fontSize: 12,
  },
  markRow: {
    marginTop: 8,
    flexDirection: "row",
    gap: 8,
  },
  mark: {
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  markOn: {
    borderColor: tokens.text,
    backgroundColor: tokens.fillMuted,
  },
  markText: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  error: {
    marginTop: 8,
    color: tokens.danger,
    fontSize: 13,
  },
  footer: {
    marginTop: 12,
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 16,
  },
});
