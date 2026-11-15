import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";

interface StripProps {
  readonly style?: StyleProp<ViewStyle>;
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
 * The system photo picker drawn in place. A pick calls `onPicked` with the share intake id the
 * photos were copied to; a picker that cannot run calls `onUnavailable`.
 */
export function PhotoStrip({
  style,
  onPicked,
  onUnavailable,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly onPicked: (intakeId: string | null) => void;
  readonly onUnavailable: () => void;
}) {
  if (NativeStrip === null) return null;
  return (
    <NativeStrip
      style={style}
      onPicked={(event) => onPicked(event.nativeEvent.id ?? null)}
      onUnavailable={onUnavailable}
    />
  );
}
