import { IconCamera, IconPhoto } from "../ui/icons";
import { useRef, useState, type ComponentType } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { addPhotosLabel, type AttachPhotos } from "./attachSheetModel";
import { PhotoStrip, type PhotoStripHandle } from "./PhotoStrip";

/**
 * Plus opens this sheet: Camera on top, recent photos under it at once. A tap on a photo selects
 * it (a badge shows its place), a second tap deselects it, and the Add button under the grid
 * copies the selection into the draft. One photo is plus, photo, Add. Closing the sheet with
 * nothing added drops the selection.
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
        <EmbeddedPhotos
          maxSelection={photos.maxSelection}
          onPicked={onPicked}
          onUnavailable={onUnavailable}
        />
      ) : null}
    </SheetShell>
  );
}

/** Space the rest of the sheet takes besides the grid and the button, with room for large text. */
const SHEET_CHROME = 300;

function EmbeddedPhotos({
  maxSelection,
  onPicked,
  onUnavailable,
}: {
  readonly maxSelection: number;
  readonly onPicked: (intakeId: string | null) => void;
  readonly onUnavailable: () => void;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const strip = useRef<PhotoStripHandle>(null);
  const [count, setCount] = useState(0);
  const [adding, setAdding] = useState(false);
  const add = addPhotosLabel(count);
  // The grid shrinks before the button does, so both stay inside the sheet's 90% height.
  const gridHeight = Math.min(
    Math.round(height * 0.5),
    Math.max(160, Math.round(height * 0.9) - SHEET_CHROME - insets.bottom),
  );
  return (
    <>
      <View style={[styles.strip, { height: gridHeight }]} testID="attach-photos">
        <PhotoStrip
          ref={strip}
          style={styles.fill}
          maxSelection={maxSelection}
          onSelection={setCount}
          onPicked={onPicked}
          onUnavailable={onUnavailable}
        />
      </View>
      <Pressable
        onPress={() => {
          setAdding(true);
          strip.current?.add().catch(() => setAdding(false));
        }}
        disabled={!add.enabled || adding}
        accessibilityRole="button"
        accessibilityLabel={add.label}
        accessibilityState={{ disabled: !add.enabled || adding }}
        testID="attach-add"
        style={({ pressed }) => [
          styles.addButton,
          !add.enabled || adding ? styles.addButtonOff : null,
          pressed ? styles.addButtonPressed : null,
        ]}
      >
        <Text style={styles.addLabel} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {add.label}
        </Text>
      </Pressable>
    </>
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
  addButton: {
    marginTop: 8,
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  addButtonOff: { opacity: 0.4 },
  addButtonPressed: { opacity: 0.8 },
  addLabel: { color: tokens.primaryText, fontSize: 16, lineHeight: 22, fontWeight: "600" },
});
