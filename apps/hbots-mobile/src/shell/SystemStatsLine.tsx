import { systemStatParts } from "@hbots/personal-client/computer/systemStats";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSystemSummary } from "../computer/useSystemSummary";
import { tokens } from "./tokens";

/**
 * The PC at a glance under the Bots header: CPU, RAM and free disk, a busy
 * figure inked amber. Keeps its 16px row from the first paint so the list
 * never jumps, exactly as the web line does.
 */
export function SystemStatsLine({ native }: { readonly native: NativePersonal }) {
  const summary = useSystemSummary(native);
  const parts = summary === null ? [] : systemStatParts(summary);
  return (
    <View style={styles.line}>
      {parts.length > 0 ? (
        <Text
          style={styles.text}
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          ellipsizeMode="tail"
        >
          {parts.map((part, index) => (
            <Text key={part.key} style={part.busy ? styles.busy : undefined}>
              {index > 0 ? " · " : ""}
              {part.text}
            </Text>
          ))}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    minHeight: 16,
    marginTop: -6,
    marginBottom: 4,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  text: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  busy: { color: tokens.reviewText },
});
