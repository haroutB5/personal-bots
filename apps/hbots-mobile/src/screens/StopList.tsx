import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  beginStop,
  failStop,
  pruneAttempts,
  stopListView,
  type StopAttempts,
  type StopRow,
} from "../working/stopListModel";
import { useWorkingThreads } from "../working/useWorkingThreads";

/**
 * Every chat that is running, each with a Stop button. Stop is the same `interruptTurn` command the
 * chat menu uses. It opens from the "bots working" notification (hbots://stop), behind the app lock.
 */
export function StopList({
  native,
  chat,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const working = useWorkingThreads(native);
  const interrupt = native.client.useAtomCommand(chat.thread.interruptTurn, {
    reportFailure: false,
  });
  const [attempts, setAttempts] = useState<StopAttempts>(() => new Map());

  // A stop that no longer matches a running chat is forgotten, so a chat that starts again is fresh.
  const pruned = working.status === "ready" ? pruneAttempts(attempts, working.threads) : attempts;
  if (pruned !== attempts) setAttempts(pruned);

  if (working.status === "loading") {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Checking what is working…</Text>
      </View>
    );
  }

  const view = stopListView(working.threads, attempts);

  const stop = async (threadId: string) => {
    setAttempts((current) => beginStop(current, threadId));
    const result = await interrupt({ environmentId, input: { threadId: ThreadId.make(threadId) } });
    const failure = commandFailureMessage(result, "Couldn't stop this turn.");
    if (failure !== null) setAttempts((current) => failStop(current, threadId, failure));
  };

  if (view.kind === "empty") {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{view.headline}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={styles.headline}>{view.headline}</Text>
      {view.rows.map((row) => (
        <Row key={row.threadId} row={row} onStop={() => void stop(row.threadId)} />
      ))}
    </ScrollView>
  );
}

function Row({ row, onStop }: { readonly row: StopRow; readonly onStop: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.botName} numberOfLines={1}>
          {row.botName}
        </Text>
        <Text style={styles.chatTitle} numberOfLines={1}>
          {row.title}
        </Text>
        {row.message === null ? null : <Text style={styles.error}>{row.message}</Text>}
      </View>
      <Pressable
        onPress={onStop}
        disabled={!row.canStop}
        accessibilityRole="button"
        accessibilityLabel={`${row.buttonLabel} ${row.botName}`}
        accessibilityState={{ disabled: !row.canStop }}
        style={[styles.button, !row.canStop && styles.buttonDisabled]}
      >
        <Text style={styles.buttonText}>{row.buttonLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  muted: { color: tokens.textSecondary, fontSize: 15 },
  title: { color: tokens.text, fontSize: 17 },
  list: { padding: 16, gap: 8 },
  headline: { color: tokens.sectionLabel, fontSize: 13, marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    minHeight: 64,
    borderRadius: 12,
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  rowText: { flex: 1, gap: 2 },
  botName: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  chatTitle: { color: tokens.textSecondary, fontSize: 14 },
  error: { color: tokens.error, fontSize: 13, marginTop: 2 },
  button: {
    minWidth: 88,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.dangerBg,
    borderWidth: 1,
    borderColor: tokens.dangerBorder,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
});
