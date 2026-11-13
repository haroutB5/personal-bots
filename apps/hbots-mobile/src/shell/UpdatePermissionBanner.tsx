import { IconDownload } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text } from "react-native";

import { confirmUpdateInstall, type UpdateSnapshot } from "../updater";
import { updateBannerModel } from "../updateView";
import { tokens } from "./tokens";

/**
 * "hbots X is ready." with a Restart button, or "Update to X is waiting. Allow hbots to install
 * updates.", which opens the system page for the permission. It follows the updater's snapshot.
 */
export function UpdatePermissionBanner({
  update,
  onPress,
}: {
  readonly update: UpdateSnapshot | null;
  readonly onPress: () => void;
}) {
  const model = updateBannerModel(update);
  if (model === null) return null;
  const restart = model.action === "restart";
  return (
    <Pressable
      onPress={restart ? () => void confirmUpdateInstall() : onPress}
      accessibilityRole="button"
      accessibilityLabel={model.text}
      style={styles.banner}
    >
      <IconDownload size={16} color={tokens.text} strokeWidth={1.75} />
      <Text style={styles.text} numberOfLines={2}>
        {model.text}
      </Text>
      {restart ? <Text style={styles.restart}>Restart</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  restart: {
    overflow: "hidden",
    borderRadius: 14,
    backgroundColor: tokens.text,
    color: tokens.reviewBg,
    paddingHorizontal: 14,
    paddingVertical: 5,
    fontSize: 14,
    fontWeight: "600",
  },
  text: { flex: 1, minWidth: 0, color: tokens.text, fontSize: 14, fontWeight: "500" },
});
