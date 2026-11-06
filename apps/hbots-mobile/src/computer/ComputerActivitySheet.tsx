import type { PersonalBrowserFile } from "@t3tools/contracts";
import { groupActivity } from "@hbots/personal-client/computer/computerActivity";
import type { ComputerActivityEvent } from "@hbots/personal-client/computer/computerContract";
import { formatActivityTime } from "@hbots/personal-client/computer/computerModel";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { ActivityList } from "./ComputerCards";
import { formatFileRow as formatFileRowFromModel } from "./computerScreenModel";

export function ComputerActivitySheet({
  native,
  open,
  events,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly open: boolean;
  readonly events: ReadonlyArray<ComputerActivityEvent>;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<"activity" | "files">("activity");
  const groups = groupActivity(events.slice(0, 30));
  return (
    <SheetShell visible={open} title="Recent activity" onClose={onClose}>
      <Text style={styles.subtitle}>Browser and desktop, newest first</Text>
      <View style={styles.tabs} accessibilityRole="tablist">
        {(["activity", "files"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)}
            style={[styles.tab, tab === value ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === value ? styles.tabTextActive : null]}>
              {value === "activity" ? "Activity" : "Files"}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "files" ? (
        <FilesList native={native} />
      ) : groups.length === 0 ? (
        <Text style={styles.empty}>
          No activity yet. Each step a bot takes on the computer shows here, newest first.
        </Text>
      ) : (
        <ActivityList groups={groups} />
      )}
    </SheetShell>
  );
}

function FilesList({ native }: { readonly native: NativePersonal }) {
  const query = native.computer.useComputerFiles(native.environmentId);
  if (query.isPending) {
    return <ActivityIndicator color={tokens.textSecondary} style={styles.loading} />;
  }
  if (query.error !== null) {
    return <Text style={styles.error}>{query.error}</Text>;
  }
  const files = query.data?.files ?? [];
  if (files.length === 0) {
    return (
      <Text style={styles.empty}>
        No saved files yet. Screenshots and downloads a bot saves show here.
      </Text>
    );
  }
  return (
    <View>
      {files.map((file) => (
        <FileRow key={file.id} file={file} />
      ))}
    </View>
  );
}

function FileRow({ file }: { readonly file: PersonalBrowserFile }) {
  const row = formatFileRowFromModel(file);
  return (
    <View style={styles.fileRow} accessibilityLabel={`${row.title}, ${row.detail}`}>
      <View style={styles.fileText}>
        <Text style={styles.fileTitle} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {row.title}
        </Text>
        <Text style={styles.fileDetail} maxFontSizeMultiplier={1.4}>
          {row.detail} · {formatActivityTime(file.modifiedAt)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: tokens.textSecondary, fontSize: 14, paddingHorizontal: 4, marginBottom: 8 },
  tabs: {
    flexDirection: "row",
    height: 44,
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
    padding: 2,
    marginBottom: 8,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  tabActive: {
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  tabText: { color: tokens.textSecondary, fontSize: 14 },
  tabTextActive: { color: tokens.text, fontWeight: "600" },
  empty: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    padding: 16,
    textAlign: "center",
  },
  error: { color: tokens.danger, fontSize: 14, padding: 16, textAlign: "center" },
  loading: { padding: 24 },
  fileRow: { minHeight: 52, justifyContent: "center", paddingHorizontal: 12 },
  fileText: { gap: 2 },
  fileTitle: { color: tokens.text, fontSize: 15 },
  fileDetail: { color: tokens.textSecondary, fontSize: 13 },
});
