import { IconCamera, IconPhoto } from "@tabler/icons-react-native";
import type { ComponentType } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import type { AttachPhotos } from "./attachSheetModel";
import { PhotoStrip } from "./PhotoStrip";

/**
 * Plus opens this sheet: Camera on top, recent photos under it at once. One tap opens it and one
 * tap picks, the same count as when plus opened the system picker directly.
 */
export function AttachSheet({
  visible,
  photos,
  onClose,
  onCamera,
  onAllPhotos,
  onPicked,
  onUnavailable,
}: {
  readonly visible: boolean;
  readonly photos: AttachPhotos;
  readonly onClose: () => void;
  readonly onCamera: () => void;
  readonly onAllPhotos: () => void;
  readonly onPicked: (intakeId: string | null) => void;
  readonly onUnavailable: () => void;
}) {
  const { height } = useWindowDimensions();
  return (
    <SheetShell visible={visible} title="Add" onClose={onClose}>
      <SourceRow icon={IconCamera} label="Camera" testID="attach-camera" onPress={onCamera} />
      {photos.kind === "all-photos" ? (
        <SourceRow
          icon={IconPhoto}
          label="All photos"
          testID="attach-all-photos"
          onPress={onAllPhotos}
        />
      ) : null}
      {photos.kind === "full" ? <Text style={styles.full}>{photos.message}</Text> : null}
      {/* Mounted only while open: unmounting closes the picker session and its grants. */}
      {photos.kind === "embedded" && visible ? (
        <View style={[styles.strip, { height: Math.round(height * 0.5) }]} testID="attach-photos">
          <PhotoStrip style={styles.fill} onPicked={onPicked} onUnavailable={onUnavailable} />
        </View>
      ) : null}
    </SheetShell>
  );
}

function SourceRow({
  icon: Icon,
  label,
  testID,
  onPress,
}: {
  readonly icon: ComponentType<{ size: number; color: string; strokeWidth: number }>;
  readonly label: string;
  readonly testID: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.rowIcon}>
        <Icon size={24} color={tokens.text} strokeWidth={1.75} />
      </View>
      <Text style={styles.rowLabel} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 72,
    paddingHorizontal: 12,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  rowPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  rowIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { color: tokens.text, fontSize: 16, lineHeight: 22, fontWeight: "500" },
  full: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  strip: { marginTop: 4, borderRadius: 12, overflow: "hidden" },
  fill: { flex: 1 },
});
