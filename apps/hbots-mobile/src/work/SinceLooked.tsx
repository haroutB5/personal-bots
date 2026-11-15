import type { WorkDigest, WorkDigestTone } from "@hbots/personal-client/work/workDigest";
import { workDigestView } from "@hbots/personal-client/work/workDigest";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";

const TONE_COLOR: Record<WorkDigestTone, string> = {
  failure: tokens.error,
  done: tokens.working,
  dropped: tokens.textSecondary,
  restarted: tokens.needs,
  started: tokens.info,
};

/**
 * What happened while the owner was away, failures first. Five lines, then a
 * fold; Clear moves the seen marker to the newest server time.
 */
export function SinceLooked({
  digest,
  onClear,
}: {
  readonly digest: WorkDigest;
  readonly onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const view = workDigestView(digest, expanded);
  return (
    <View testID="work-digest">
      <View style={styles.header}>
        <Text style={styles.headerText} maxFontSizeMultiplier={1.3}>
          Since you looked · {digest.span} ago
        </Text>
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel="Clear since you looked"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          testID="work-digest-clear"
        >
          <Text style={styles.clear} maxFontSizeMultiplier={1.3}>
            Clear
          </Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        {view.lines.map((line) => (
          <Text key={line.key} style={styles.line} maxFontSizeMultiplier={1.3}>
            <Text style={{ color: TONE_COLOR[line.tone] }}>{line.symbol}</Text> {line.text}
          </Text>
        ))}
        {view.moreLabel === null ? null : (
          <Pressable
            onPress={() => setExpanded(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show ${view.moreLabel.slice(1)}`}
            testID="work-digest-more"
          >
            <Text style={styles.more} maxFontSizeMultiplier={1.3}>
              {view.moreLabel}
            </Text>
          </Pressable>
        )}
        {digest.omitted === 0 ? null : (
          <Text style={styles.omitted} maxFontSizeMultiplier={1.3}>
            {digest.omitted} older not shown
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  headerText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  clear: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  card: {
    borderRadius: 14,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 4,
  },
  line: { color: tokens.textPreview, fontSize: 13, lineHeight: 19 },
  more: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500", paddingTop: 2 },
  omitted: { color: tokens.textTertiary, fontSize: 12, paddingTop: 2 },
});
