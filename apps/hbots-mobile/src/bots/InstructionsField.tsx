import {
  instructionsCollapsedHeight,
  instructionsExpandedAfter,
  instructionsFieldView,
} from "@hbots/personal-client/bots/instructionsField";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { tokens } from "../shell/tokens";

const LINE_HEIGHT = 22;
const PADDING_VERTICAL = 10;
const COLLAPSED_HEIGHT = instructionsCollapsedHeight(LINE_HEIGHT, PADDING_VERTICAL * 2);
/** Bands that step the field colour in over the last visible line. No gradient library. */
const FADE_BANDS = [0.25, 0.5, 0.75, 0.92];

/**
 * Opens on its first lines; a tap in the box or "Show all" opens it. The same
 * input stays mounted, so no edit is lost. No animation, so reduced motion is safe.
 */
export function InstructionsField({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const view = instructionsFieldView({
    expanded,
    contentHeight,
    collapsedHeight: COLLAPSED_HEIGHT,
  });
  const collapsed = view.clipHeight !== null;

  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={1.6}>
        Instructions
      </Text>
      <View>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChange}
          onFocus={() => setExpanded((current) => instructionsExpandedAfter(current, "focus"))}
          onContentSizeChange={(event) =>
            setContentHeight(event.nativeEvent.contentSize.height + PADDING_VERTICAL * 2)
          }
          placeholder={placeholder}
          placeholderTextColor={tokens.textTertiary}
          multiline
          // Collapsed, the page scrolls, not the box.
          scrollEnabled={!collapsed}
          textAlignVertical="top"
          autoComplete="off"
          autoCorrect={false}
          accessibilityLabel="Instructions"
          testID="bot-instructions"
          maxFontSizeMultiplier={1.6}
          style={[styles.input, collapsed ? { maxHeight: view.clipHeight ?? undefined } : null]}
        />
        {view.fade ? (
          <View pointerEvents="none" style={styles.fade} testID="bot-instructions-fade">
            {FADE_BANDS.map((opacity) => (
              <View key={opacity} style={[styles.fadeBand, { opacity }]} />
            ))}
          </View>
        ) : null}
      </View>
      {view.control === null ? null : (
        <Pressable
          onPress={() => {
            // "Show less" leaves the box, so the next tap in it opens it again.
            if (expanded) inputRef.current?.blur();
            setExpanded((current) => instructionsExpandedAfter(current, "toggle"));
          }}
          accessibilityRole="button"
          accessibilityLabel={`${view.control} instructions`}
          accessibilityState={{ expanded }}
          hitSlop={8}
          style={styles.control}
          testID="bot-instructions-toggle"
        >
          <Text style={styles.controlText} maxFontSizeMultiplier={1.6}>
            {view.control}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 8 },
  label: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  input: {
    minHeight: 120,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    color: tokens.text,
    paddingHorizontal: 14,
    paddingVertical: PADDING_VERTICAL,
    fontSize: 16,
    lineHeight: LINE_HEIGHT,
  },
  fade: {
    position: "absolute",
    left: 1,
    right: 1,
    bottom: 1,
    height: LINE_HEIGHT * 2,
    borderBottomLeftRadius: 11,
    borderBottomRightRadius: 11,
    overflow: "hidden",
  },
  fadeBand: { flex: 1, backgroundColor: tokens.fillMuted },
  control: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  controlText: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
    textDecorationLine: "underline",
  },
});
