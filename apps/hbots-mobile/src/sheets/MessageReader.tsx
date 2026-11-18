import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions } from "react-native";

import { readerDoc, type ReaderRun, type ReaderStyle } from "../chat/readerDoc";
import { tokens } from "../shell/tokens";

export const STREAMING_NOTE = "Still writing. This is the text so far.";

/**
 * One selectable `Text` in a scroller: a drag of a handle can cross paragraphs and code. The text
 * is a snapshot taken when the sheet opened, so a growing reply never rewrites it under a selection.
 */
export function MessageReader({
  text,
  streaming,
}: {
  readonly text: string;
  readonly streaming: boolean;
}) {
  const { height } = useWindowDimensions();
  const keyedRuns = useMemo(() => keyRuns(readerDoc(text).runs), [text]);
  return (
    <>
      {streaming ? <Text style={styles.note}>{STREAMING_NOTE}</Text> : null}
      <ScrollView
        style={[styles.scroll, { maxHeight: Math.round(height * 0.7) }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text selectable accessibilityLabel="Message text" style={styles.text}>
          {keyedRuns.map(({ key, run }) => (
            <Text key={key} style={RUN_STYLES[run.style]}>
              {run.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </>
  );
}

/** Runs keyed by where they start in the text: stable, unique and not an array index. */
function keyRuns(runs: ReadonlyArray<ReaderRun>): { key: string; run: ReaderRun }[] {
  const keyed: { key: string; run: ReaderRun }[] = [];
  let start = 0;
  for (const run of runs) {
    keyed.push({ key: String(start), run });
    start += run.text.length;
  }
  return keyed;
}

const styles = StyleSheet.create({
  note: { color: tokens.textSecondary, fontSize: 13, marginHorizontal: 12, marginTop: 8 },
  scroll: {
    margin: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  content: { padding: 12 },
  text: { color: tokens.text, fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  code: { fontFamily: "monospace", fontSize: 14 },
  link: { color: tokens.primary, textDecorationLine: "underline" },
  heading: { fontWeight: "700", fontSize: 17 },
  codeBlock: { fontFamily: "monospace", fontSize: 13 },
});

const RUN_STYLES: Record<ReaderStyle, object | null> = {
  plain: null,
  bold: styles.bold,
  italic: styles.italic,
  code: styles.code,
  link: styles.link,
  heading: styles.heading,
  codeBlock: styles.codeBlock,
};
