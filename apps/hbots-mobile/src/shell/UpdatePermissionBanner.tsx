import { IconDownload } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text } from "react-native";

import type { UpdateSnapshot } from "../updater";
import { updateBannerModel } from "../updateView";
import { tokens } from "./tokens";

/**
 * "Update to X is waiting. Allow hbots to install updates." Tapping it opens
 * the system page for the permission. It disappears when the snapshot leaves
 * the needsPermission state, which the updater does on the next foreground.
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
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={model.text}
      style={styles.banner}
    >
      <IconDownload size={16} color={tokens.text} strokeWidth={1.75} />
      <Text style={styles.text} numberOfLines={2}>
        {model.text}
      </Text>
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
  text: { flex: 1, minWidth: 0, color: tokens.text, fontSize: 14, fontWeight: "500" },
});
