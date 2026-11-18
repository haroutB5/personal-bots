import { useImperativeHandle, useMemo, useRef, type Ref } from "react";
import {
  findNodeHandle,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  type View,
} from "react-native";

import {
  anchorOffset,
  readerDoc,
  type ReaderRun,
  type ReaderStyle,
  type TextHit,
} from "../chat/readerDoc";
import { clearSelection, selectWordAt, watchSelection } from "../chat/textSelectNative";
import { tokens } from "../shell/tokens";

export interface ReaderHandle {
  /** Clears the selection and its handles. True when something was selected. */
  readonly clearSelection: () => Promise<boolean>;
}

/** The sheet slide-in, plus a margin, before the native selection starts. */
const SHEET_SETTLE_MS = 500;

export const STREAMING_NOTE = "Still writing. This is the text so far.";

/**
 * One selectable `Text` in a scroller: a drag of a handle can cross paragraphs and code. The text
 * is a snapshot taken when the sheet opened, so a growing reply never rewrites it under a selection.
 */
export function MessageReader({
  text,
  streaming,
  hit,
  ref,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly hit: TextHit | null;
  readonly ref?: Ref<ReaderHandle>;
}) {
  const scroller = useRef<ScrollView>(null);
  const textNode = useRef<Text>(null);
  const selectedFor = useRef<TextHit | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      clearSelection: async () => {
        const tag =
          textNode.current === null ? null : findNodeHandle(textNode.current as unknown as View);
        return tag === null ? false : clearSelection(tag);
      },
    }),
    [],
  );
  const selectTapped = () => {
    const watchTag =
      textNode.current === null ? null : findNodeHandle(textNode.current as unknown as View);
    if (watchTag !== null) void watchSelection(watchTag);
    if (hit === null || selectedFor.current === hit) return;
    selectedFor.current = hit;
    const offset = anchorOffset(readerDoc(text), hit);
    if (offset === null) return;
    // Handles and the toolbar are dropped when the text moves, so wait for the sheet to stop sliding.
    setTimeout(() => {
      const tag =
        textNode.current === null ? null : findNodeHandle(textNode.current as unknown as View);
      if (tag === null) return;
      void selectWordAt(tag, offset).then((result) => {
        if (result !== null)
          scroller.current?.scrollTo({ y: Math.max(0, result.lineTop - 96), animated: false });
      });
    }, SHEET_SETTLE_MS);
  };
  const { height } = useWindowDimensions();
  const keyedRuns = useMemo(() => keyRuns(readerDoc(text).runs), [text]);
  return (
    <>
      {streaming ? <Text style={styles.note}>{STREAMING_NOTE}</Text> : null}
      <ScrollView
        ref={scroller}
        style={[styles.scroll, { maxHeight: Math.round(height * 0.7) }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          ref={textNode}
          selectable
          accessibilityLabel="Message text"
          style={styles.text}
          onTextLayout={selectTapped}
        >
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
