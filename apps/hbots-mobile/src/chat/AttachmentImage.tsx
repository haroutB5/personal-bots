import type { ChatAttachment } from "@t3tools/contracts";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import { imageLayers, localImages } from "./localImages";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";

/**
 * A sent photo drawn as the web draws it: the image itself, and a tap opens it
 * full screen. Attachments carry no URL of their own; the server mints one per
 * attachment id for this session. A photo this phone just sent is drawn from its device file
 * until the server's copy has drawn on top of it.
 */
export function AttachmentImage({
  native,
  chat,
  messageId,
  index,
  attachment,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  /** The echoed message. Its id and the image's place survive the server's attachment claim. */
  readonly messageId: string;
  readonly index: number;
  readonly attachment: Extract<ChatAttachment, { readonly type: "image" }>;
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(() => localImages.uriFor(messageId, index));
  const [remoteDrawn, setRemoteDrawn] = useState(false);
  const state = assetUrlStateFromResult(
    useAtomValue(
      chat.assets.createUrl({
        environmentId: native.environmentId,
        input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
      }),
    ),
    native.httpBaseUrl,
  );

  const layers = imageLayers({
    local,
    remoteUrl: state._tag === "Success" ? state.url : null,
    remoteDrawn,
  });

  if (layers.remote === null && layers.local === null) {
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
        <View style={styles.thumb}>
          {layers.local === null ? null : (
            <Image
              source={{ uri: layers.local }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              resizeMethod="resize"
              onError={() => setLocal(null)}
            />
          )}
          {layers.remote === null ? null : (
            <Image
              source={{ uri: layers.remote }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              resizeMethod="resize"
              accessibilityLabel={attachment.name}
              onLoad={() => {
                setRemoteDrawn(true);
                localImages.drawn(messageId, index);
              }}
            />
          )}
        </View>
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
          <Image
            source={{ uri: layers.remote ?? layers.local ?? "" }}
            style={styles.viewerImage}
            resizeMode="contain"
          />
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * An image in a bubble the server has not echoed yet, drawn from the file it was picked from.
 * A file that is gone (an app restart can clear the picker cache) shows the name instead.
 */
export function PendingAttachmentImage({
  uri,
  name,
  onDrawn,
}: {
  readonly uri: string;
  readonly name: string;
  readonly onDrawn: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.placeholder} accessibilityLabel={name}>
        <Text style={styles.placeholderText} numberOfLines={2}>
          {name}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.thumbButton, styles.thumb]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        resizeMethod="resize"
        accessibilityLabel={name}
        onLoad={onDrawn}
        onError={() => setFailed(true)}
      />
    </View>
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
