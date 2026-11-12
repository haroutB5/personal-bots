import { formatCallDuration } from "@hbots/personal-client/conversation/voice/callState";
import type { VoiceCallCardItem } from "@hbots/personal-client/conversation/conversationModel";
import type {
  VoiceCallSummary,
  VoiceCallTranscriptEntry,
} from "@hbots/personal-client/conversation/voice/voiceCallApi";
import { IconChevronDown, IconPhone } from "@tabler/icons-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { TurnIcon } from "../motion/TurnIcon";
import { tokens } from "../shell/tokens";
import { cardFooterLine, rowKeys, sentLine, transcriptOffset } from "./callViewModel";

export function CallSummaryView({ summary }: { readonly summary: VoiceCallSummary }) {
  const points = summary.points.filter((point) => point.trim().length > 0);
  const decision = summary.decision?.trim() ?? "";
  const open = summary.open?.trim() ?? "";
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryText} maxFontSizeMultiplier={1.4}>
        {summary.summary}
      </Text>
      {points.map((point) => (
        <View key={point} style={styles.point}>
          <View style={styles.bullet} />
          <Text style={styles.pointText} maxFontSizeMultiplier={1.4}>
            {point}
          </Text>
        </View>
      ))}
      {decision.length === 0 ? null : (
        <View style={styles.decision}>
          <Text style={styles.decisionLabel} maxFontSizeMultiplier={1.4}>
            Decided:
          </Text>
          <Text style={styles.decisionText} maxFontSizeMultiplier={1.4}>
            {decision}
          </Text>
        </View>
      )}
      {open.length === 0 ? null : (
        <Text style={styles.open} maxFontSizeMultiplier={1.4}>
          <Text style={styles.openLabel}>Still open: </Text>
          {open}
        </Text>
      )}
    </View>
  );
}

export function TranscriptRows({
  rows,
  startedAtMs,
  voiceName,
}: {
  readonly rows: ReadonlyArray<VoiceCallTranscriptEntry>;
  readonly startedAtMs: number;
  readonly voiceName: string | null;
}) {
  return (
    <View>
      {rowKeys(rows).map(({ row, key }) => (
        <View key={key} style={styles.row}>
          <Text style={styles.offset} maxFontSizeMultiplier={1.3}>
            {transcriptOffset(startedAtMs, row.at)}
          </Text>
          <Text
            style={[styles.who, row.speaker === "you" ? styles.whoYou : null]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {row.speaker === "you" ? "You" : (voiceName ?? "Voice")}
          </Text>
          <Text style={styles.line} maxFontSizeMultiplier={1.4}>
            {row.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function CallCardView({
  card,
  live = false,
  onCallBack,
  onReturn,
  transcript,
}: {
  readonly card: VoiceCallCardItem;
  readonly live?: boolean;
  readonly onCallBack?: (() => void) | undefined;
  readonly onReturn: () => void;
  readonly transcript?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const duration = formatCallDuration(card.durationMs);
  return (
    <View
      style={styles.card}
      accessibilityLabel={live ? `On a call, ${duration}` : `Voice call, ${duration}`}
    >
      <View style={styles.head}>
        <View style={[styles.icon, live ? styles.iconLive : null]}>
          <IconPhone size={18} color={live ? tokens.bg : tokens.text} strokeWidth={1.75} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.title} maxFontSizeMultiplier={1.4}>
            {live ? `On a call · ${duration}` : `Voice call · ${duration}`}
          </Text>
          <Text style={styles.sub} maxFontSizeMultiplier={1.4}>
            {live
              ? "Tap to return to the call"
              : `${sentLine(card.sentCount)} · ${card.endedLine ?? ""}`}
          </Text>
        </View>
        {live || onCallBack !== undefined ? (
          <Pressable
            onPress={live ? onReturn : onCallBack}
            accessibilityRole="button"
            accessibilityLabel={live ? "Return to the call" : "Call back"}
            style={styles.action}
          >
            <Text style={styles.actionText} maxFontSizeMultiplier={1.4}>
              {live ? "Return" : "Call back"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {live || card.summary === undefined ? null : <CallSummaryView summary={card.summary} />}

      {live ? null : (
        <>
          <Pressable
            onPress={() => setOpen((previous) => !previous)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel="Transcript"
            style={styles.toggle}
          >
            <Text style={styles.toggleText} maxFontSizeMultiplier={1.4}>
              Transcript
            </Text>
            <TurnIcon turned={open} degrees={180}>
              <IconChevronDown size={16} color={tokens.textSecondary} strokeWidth={1.75} />
            </TurnIcon>
          </Pressable>
          {open ? (
            <View style={styles.transcript}>
              {transcript ?? (
                <TranscriptRows
                  rows={card.transcript}
                  startedAtMs={card.startedAtMs}
                  voiceName={card.voiceName}
                />
              )}
              <Text style={styles.footer} maxFontSizeMultiplier={1.3}>
                {cardFooterLine(card)}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    marginHorizontal: 12,
    marginVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  iconLive: { backgroundColor: tokens.working },
  headText: { flex: 1, minWidth: 0 },
  title: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  sub: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  action: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { color: tokens.text, fontSize: 13, fontWeight: "600" },
  summary: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: 8,
    gap: 6,
  },
  summaryText: { color: tokens.text, fontSize: 14, lineHeight: 19 },
  point: { flexDirection: "row", gap: 8 },
  bullet: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 8,
    backgroundColor: tokens.textTertiary,
  },
  pointText: { flex: 1, color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  decision: {
    flexDirection: "row",
    gap: 6,
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  decisionLabel: { color: tokens.text, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  decisionText: { flex: 1, color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  open: { color: tokens.textTertiary, fontSize: 13, lineHeight: 18 },
  openLabel: { color: tokens.textSecondary, fontWeight: "600" },
  toggle: {
    marginTop: 8,
    minHeight: 44,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  toggleText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  transcript: { paddingBottom: 12 },
  row: { flexDirection: "row", gap: 8, paddingVertical: 2 },
  offset: {
    width: 34,
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 19,
    fontVariant: ["tabular-nums"],
  },
  who: { width: 52, color: tokens.textTertiary, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  whoYou: { color: tokens.textSecondary },
  line: { flex: 1, color: tokens.text, fontSize: 14, lineHeight: 19 },
  footer: { marginTop: 8, color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
});
