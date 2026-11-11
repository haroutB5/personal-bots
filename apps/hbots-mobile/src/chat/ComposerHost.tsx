import { requireNativeView } from "expo";
import type { ReactNode } from "react";
import { Platform, View, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";

interface HostProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
  readonly onEnterSend?: () => void;
  readonly onContent?: (event: NativeSyntheticEvent<{ readonly id?: string }>) => void;
}

function load() {
  if (Platform.OS !== "android") return null;
  try {
    return requireNativeView<HostProps>("HbotsShare");
  } catch {
    // An old build without the view: the composer works, minus the keyboard extras.
    return null;
  }
}

const NativeHost = load();

/**
 * Wraps the composer's TextInput. A hardware Enter calls `onEnterSend` (Shift Enter is a
 * line break, the soft keyboard is untouched) and a keyboard image calls `onContent` with
 * the share intake id the image was copied to.
 */
export function ComposerHost({
  style,
  children,
  onEnterSend,
  onContent,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
  readonly onEnterSend: () => void;
  readonly onContent: (intakeId: string | null) => void;
}) {
  if (NativeHost === null) return <View style={style}>{children}</View>;
  return (
    <NativeHost
      style={style}
      onEnterSend={onEnterSend}
      onContent={(event) => onContent(event.nativeEvent.id ?? null)}
    >
      {children}
    </NativeHost>
  );
}
