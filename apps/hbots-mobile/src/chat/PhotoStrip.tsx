import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { Ref } from "react";
import { Platform, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";

/** What the native view lets the sheet do: copy the photos selected so far. */
export interface PhotoStripHandle {
  add(): Promise<void>;
}

interface StripProps {
  readonly ref?: Ref<PhotoStripHandle>;
  readonly style?: StyleProp<ViewStyle>;
  readonly maxSelection: number;
  readonly onSelection: (event: NativeSyntheticEvent<{ readonly count: number }>) => void;
  readonly onPicked: (event: NativeSyntheticEvent<{ readonly id?: string }>) => void;
  readonly onUnavailable: () => void;
}

const native = requireOptionalNativeModule<{ embeddedPickerAvailable(): boolean }>("HbotsShare");

function load() {
  if (Platform.OS !== "android" || native === null) return null;
  try {
    return requireNativeView<StripProps>("HbotsShare", "HbotsPhotoStripView");
  } catch {
    return null;
  }
}

const NativeStrip = load();

/** Android 14+ with a photo picker module that can be embedded. Older builds and phones say no. */
export function embeddedPickerAvailable(): boolean {
  if (NativeStrip === null) return false;
  try {
    return native?.embeddedPickerAvailable() ?? false;
  } catch {
    return false;
  }
}

/**
 * The system photo picker drawn in place. Taps select up to `maxSelection` photos and report the
 * count; `ref.add()` copies them and calls `onPicked` with the share intake id. A picker that
 * cannot run calls `onUnavailable`.
 */
export function PhotoStrip({
  ref,
  style,
  maxSelection,
  onSelection,
  onPicked,
  onUnavailable,
}: {
  readonly ref?: Ref<PhotoStripHandle>;
  readonly style?: StyleProp<ViewStyle>;
  readonly maxSelection: number;
  readonly onSelection: (count: number) => void;
  readonly onPicked: (intakeId: string | null) => void;
  readonly onUnavailable: () => void;
}) {
  if (NativeStrip === null) return null;
  return (
    <NativeStrip
      ref={ref}
      style={style}
      maxSelection={maxSelection}
      onSelection={(event) => onSelection(event.nativeEvent.count)}
      onPicked={(event) => onPicked(event.nativeEvent.id ?? null)}
      onUnavailable={onUnavailable}
    />
  );
}
