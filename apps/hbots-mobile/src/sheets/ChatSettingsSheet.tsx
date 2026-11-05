import type {
  ChatSettingsHeader,
  ChatSettingsRow,
  ChatSettingsRowId,
} from "@hbots/personal-client/bots/chatSettingsModel";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

function Row({
  row,
  onSelect,
}: {
  readonly row: ChatSettingsRow;
  readonly onSelect: (id: ChatSettingsRowId) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.detail === null ? row.label : `${row.label}, ${row.detail}`}
      accessibilityState={{ disabled: row.disabled }}
      disabled={row.disabled}
      onPress={() => onSelect(row.id)}
      style={({ pressed }) => [
        styles.row,
        row.disabled ? styles.rowDisabled : null,
        pressed && !row.disabled ? styles.rowPressed : null,
      ]}
    >
      <Text
        style={[
          styles.rowLabel,
          row.destructive ? styles.destructive : null,
          row.disabled ? styles.muted : null,
        ]}
      >
        {row.label}
      </Text>
      {row.detail === null ? null : (
        <Text style={[styles.rowDetail, row.disabled ? styles.muted : null]}>{row.detail}</Text>
      )}
    </Pressable>
  );
}

/**
 * One chat's settings, in the phone's bottom sheet. The rows come from the
 * shared model, so the phone offers the same actions in the same groups as the
 * web's sheet.
 */
export function ChatSettingsSheet({
  visible,
  header,
  groups,
  onClose,
  onSelect,
}: {
  readonly visible: boolean;
  readonly header: ChatSettingsHeader | null;
  readonly groups: ReadonlyArray<ReadonlyArray<ChatSettingsRow>>;
  readonly onClose: () => void;
  readonly onSelect: (id: ChatSettingsRowId) => void;
}) {
  return (
    <SheetShell
      visible={visible && header !== null}
      title={header?.title ?? "Chat settings"}
      onClose={onClose}
    >
      {header === null ? null : (
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: 8 }}>
          <View style={styles.header}>
            <Text style={styles.meta}>{header.meta}</Text>
            {header.preview === null ? null : (
              <Text style={styles.preview} numberOfLines={1}>
                {header.preview}
              </Text>
            )}
          </View>
          {groups.map((group, index) => (
            <View key={group[0]?.id ?? index} style={styles.group}>
              {group.map((row) => (
                <Row key={row.id} row={row} onSelect={onSelect} />
              ))}
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancel, pressed ? styles.rowPressed : null]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </ScrollView>
      )}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  meta: {
    color: tokens.textSecondary,
    fontSize: 13,
  },
  preview: {
    marginTop: 2,
    color: tokens.textTertiary,
    fontSize: 13,
  },
  group: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingVertical: 4,
  },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: {
    backgroundColor: tokens.fillMuted,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowLabel: {
    flex: 1,
    color: tokens.text,
    fontSize: 16,
    fontWeight: "500",
  },
  rowDetail: {
    color: tokens.textSecondary,
    fontSize: 14,
  },
  destructive: {
    color: tokens.danger,
  },
  muted: {
    color: tokens.textTertiary,
  },
  cancel: {
    marginTop: 4,
    minHeight: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: {
    color: tokens.text,
    fontSize: 16,
    fontWeight: "500",
  },
});
