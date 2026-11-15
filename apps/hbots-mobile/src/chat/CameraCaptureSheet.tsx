import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { SheetCancel, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { cameraFailure } from "./cameraLaunch";

/**
 * The in-app camera behind a stuck system launcher. It uses the same CameraView as the pairing
 * scanner, so the photo path works even when expo-image-picker cannot launch an activity.
 */
export function CameraCaptureSheet({
  visible,
  reason,
  onClose,
  onPhoto,
}: {
  readonly visible: boolean;
  readonly reason: string | null;
  readonly onClose: () => void;
  readonly onPhoto: (photo: { uri: string; width: number; height: number }) => Promise<void>;
}) {
  const camera = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { height } = useWindowDimensions();

  useEffect(() => {
    if (!visible) return;
    if (permission === null || permission.granted || !permission.canAskAgain) return;
    void requestPermission();
  }, [visible, permission, requestPermission]);

  const close = () => {
    setBusy(false);
    setCameraReady(false);
    setError(null);
    onClose();
  };

  const shoot = async () => {
    if (busy || permission?.granted !== true || !cameraReady) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await camera.current?.takePictureAsync({ quality: 1 });
      if (photo === undefined) throw new Error("The camera returned no photo.");
      setCameraReady(false);
      await onPhoto({ uri: photo.uri, width: photo.width, height: photo.height });
    } catch (failure) {
      const cameraError = cameraFailure(failure);
      console.warn(
        `[camera] capture failed code=${cameraError.code} message=${cameraError.message}`,
      );
      setError(`Couldn't take the photo (${cameraError.code}).`);
    } finally {
      setBusy(false);
    }
  };

  const canShoot = permission?.granted === true && cameraReady;

  return (
    <SheetShell visible={visible} title="Take a photo" onClose={close}>
      {reason !== null ? <Text style={styles.reason}>{reason}</Text> : null}
      <View style={[styles.frame, { height: Math.round(height * 0.5) }]}>
        {visible && permission?.granted === true ? (
          <CameraView
            ref={camera}
            style={StyleSheet.absoluteFill}
            facing="back"
            onCameraReady={() => setCameraReady(true)}
            onMountError={({ message }) => {
              console.warn(`[camera] preview failed message=${message}`);
              setError("Couldn't open the camera preview.");
            }}
          />
        ) : (
          <View style={styles.placeholder}>
            {permission === null ? (
              <ActivityIndicator color={tokens.textSecondary} />
            ) : (
              <Text style={styles.help}>Camera access is off for hbots.</Text>
            )}
          </View>
        )}
      </View>
      {busy ? <Text style={styles.help}>Taking the photo…</Text> : null}
      {error !== null ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Pressable
        onPress={() => void shoot()}
        disabled={busy || !canShoot}
        accessibilityRole="button"
        accessibilityLabel="Take photo"
        testID="camera-shutter"
        style={[styles.shutter, busy || !canShoot ? styles.disabled : null]}
      >
        <View style={styles.shutterDot} />
      </Pressable>
      <SheetCancel onPress={close} />
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  reason: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  frame: {
    marginHorizontal: 12,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: tokens.bg,
  },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  help: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  error: {
    color: tokens.error,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  shutter: {
    alignSelf: "center",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: tokens.text,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
    marginBottom: 8,
  },
  shutterDot: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: tokens.text,
  },
  disabled: { opacity: 0.4 },
});
