import type { PersonalRoutine } from "@t3tools/contracts";
import { routinesForBot } from "@hbots/personal-client/conversation/routinesModel";
import { routineTriggerStatusLabel } from "@hbots/personal-client/conversation/routineStatus";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

/**
 * The bot's routines for this chat, in the bottom sheet the phone uses in place
 * of the web's side strip. Read-only here: a tap opens the routine itself.
 */
export function RoutinesSheet({
  native,
  visible,
  botId,
  botName,
  onClose,
  onOpenRoutine,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly botId: string;
  readonly botName: string;
  readonly onClose: () => void;
  readonly onOpenRoutine: (routineId: string) => void;
}) {
  const routines = native.bots.usePersonalRoutinesList(native.environmentId);
  const rows = routinesForBot(routines.data?.routines ?? [], botId);
  return (
    <SheetShell visible={visible} title={`${botName} routines`} onClose={onClose}>
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingBottom: 8 }}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>No routines for this bot yet.</Text>
        ) : (
          rows.map((routine: PersonalRoutine) => (
            <Pressable
              key={routine.routineId}
              accessibilityRole="button"
              onPress={() => onOpenRoutine(routine.routineId)}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {routine.title}
                </Text>
                <Text style={styles.status} numberOfLines={1}>
                  {routineTriggerStatusLabel(routine)}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  empty: {
    paddingVertical: 12,
    color: tokens.textSecondary,
    fontSize: 15,
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
    paddingVertical: 8,
  },
  pressed: {
    backgroundColor: tokens.fillMuted,
  },
  title: {
    color: tokens.text,
    fontSize: 14,
    fontWeight: "500",
  },
  status: {
    color: tokens.textTertiary,
    fontSize: 12,
  },
  chevron: {
    color: tokens.textTertiary,
    fontSize: 20,
  },
});
