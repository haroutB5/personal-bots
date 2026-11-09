import type { ChatAttachment } from "@t3tools/contracts";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";

/**
 * A sent photo drawn as the web draws it: the image itself, and a tap opens it
 * full screen. Attachments carry no URL of their own; the server mints one per
 * attachment id for this session.
 */
export function AttachmentImage({
  native,
  chat,
  attachment,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly attachment: Extract<ChatAttachment, { readonly type: "image" }>;
}) {
  const [open, setOpen] = useState(false);
  const state = assetUrlStateFromResult(
    useAtomValue(
      chat.assets.createUrl({
        environmentId: native.environmentId,
        input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
      }),
    ),
    native.httpBaseUrl,
  );

  if (state._tag !== "Success") {
    return (
      <View style={styles.placeholder} accessibilityLabel={attachment.name}>
        {state._tag === "Loading" ? (
          <ActivityIndicator size="small" color={tokens.textSecondary} />
        ) : (
          <Text style={styles.placeholderText} numberOfLines={2}>
            {attachment.name}
          </Text>
        )}
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={attachment.name}
        style={styles.thumbButton}
      >
        <Image
          source={{ uri: state.url }}
          style={styles.thumb}
          resizeMode="cover"
          accessibilityLabel={attachment.name}
        />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          style={styles.viewer}
        >
          <Image source={{ uri: state.url }} style={styles.viewerImage} resizeMode="contain" />
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  thumbButton: { borderRadius: 14, overflow: "hidden", marginTop: 6 },
  thumb: { width: 200, height: 160, backgroundColor: tokens.bg },
  placeholder: {
    width: 200,
    height: 96,
    marginTop: 6,
    borderRadius: 14,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
  },
  placeholderText: { color: tokens.textSecondary, fontSize: 13 },
  viewer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerImage: { width: "100%", height: "100%" },
});
