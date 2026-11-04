import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconX } from "@tabler/icons-react-native";
import { useRef } from "react";
import type { PropsWithChildren } from "react";

import { tokens } from "../shell/tokens";

export function SheetShell({
  visible,
  title,
  onClose,
  children,
}: PropsWithChildren<{
  readonly visible: boolean;
  readonly title: string;
  readonly onClose: () => void;
}>) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const translateY = useRef(new Animated.Value(0)).current;
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        translateY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > 80) {
          onClose();
          translateY.setValue(0);
          return;
        }
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 24,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 24,
        }).start();
      },
    }),
  ).current;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.backdrop}
          onPress={onClose}
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: Math.round(height * 0.9),
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.dragZone} {...responder.panHandlers}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.3}>
              {title}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.close}
            >
              <IconX size={22} color={tokens.textSecondary} strokeWidth={1.75} />
            </Pressable>
          </View>
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function SheetAction({
  label,
  detail,
  danger = false,
  disabled = false,
  onPress,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={({ pressed }) => [
        styles.row,
        pressed ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      <View style={styles.rowText}>
        <Text
          style={[styles.rowLabel, danger ? styles.dangerText : null]}
          maxFontSizeMultiplier={1.6}
        >
          {label}
        </Text>
        {detail !== undefined ? (
          <Text style={styles.rowDetail} maxFontSizeMultiplier={1.6}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function SheetCancel({ onPress }: { readonly onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Cancel"
      style={styles.cancel}
    >
      <Text style={styles.cancelText} maxFontSizeMultiplier={1.6}>
        Cancel
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: tokens.scrim,
  },
  sheet: {
    backgroundColor: tokens.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingTop: 8,
  },
  dragZone: { minHeight: 20, justifyContent: "center" },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.borderStrong,
  },
  header: {
    minHeight: 52,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: { flex: 1, color: tokens.text, fontSize: 18, lineHeight: 24, fontWeight: "700" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: 12, paddingBottom: 4 },
  row: {
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    justifyContent: "center",
  },
  rowPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  rowDisabled: { opacity: 0.4 },
  rowText: { gap: 2 },
  rowLabel: { color: tokens.text, fontSize: 16, lineHeight: 22, fontWeight: "500" },
  rowDetail: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  dangerText: { color: tokens.danger },
  cancel: {
    minHeight: 50,
    marginTop: 4,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: tokens.text, fontSize: 16, fontWeight: "500" },
});
