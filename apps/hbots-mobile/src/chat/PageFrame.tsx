import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { useAtomValue } from "@effect/atom-react";
import { requireNativeView } from "expo";
import { IconArrowsMaximize, IconX } from "@tabler/icons-react-native";
import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  pageAssetResource,
  pageFrameHeight,
  pageLinkToOpen,
  pageUrlWithTheme,
} from "./pageFrameModel";

interface NativePageViewProps {
  readonly url: string;
  /** Off inline, where the chat list owns the scroll; on in the full screen viewer. */
  readonly scrollable?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly onPageLoaded?: () => void;
  readonly onPageFailed?: (event: NativeSyntheticEvent<{ readonly reason: string }>) => void;
  readonly onContentHeight?: (event: NativeSyntheticEvent<{ readonly height: number }>) => void;
  readonly onOpenLink?: (event: NativeSyntheticEvent<{ readonly url: string }>) => void;
}

/**
 * The Kotlin view owns the WebView and its lock down. JavaScript passes the
 * signed link and hears back a height and a tapped link: the page has no
 * channel to this code.
 */
const NativePageView =
  Platform.OS === "android" ? requireNativeView<NativePageViewProps>("HbotsPageView") : null;

/**
 * A page a bot showed, inline where the bot showed it. The frame is as tall as
 * the page at this width; the button opens the same page full screen.
 */
export function PageFrame({
  native,
  chat,
  htmlRender,
  onOpenLink,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpenLink?: ((url: string) => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // The frame keeps the first link it gets: a re-minted link must not reload the page.
  const [url, setUrl] = useState<string | null>(null);
  const state = assetUrlStateFromResult(
    useAtomValue(
      chat.assets.createUrl({
        environmentId: native.environmentId,
        input: { resource: pageAssetResource(htmlRender) },
      }),
    ),
    native.httpBaseUrl,
  );
  if (url === null && state._tag === "Success") setUrl(pageUrlWithTheme(state.url));

  const openLink = (event: NativeSyntheticEvent<{ readonly url: string }>) => {
    const target = pageLinkToOpen(event.nativeEvent.url);
    if (target !== null) onOpenLink?.(target);
  };
  const unavailable = NativePageView === null || failed || state._tag === "Failure";
  const height = pageFrameHeight(htmlRender, width > 0 ? width : 336, contentHeight);

  return (
    <View style={styles.card} accessibilityLabel={`Page: ${htmlRender.title}`}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {htmlRender.title}
        </Text>
        <Pressable
          onPress={() => setOpen(true)}
          disabled={url === null || unavailable}
          accessibilityRole="button"
          accessibilityLabel="Open full screen"
          hitSlop={8}
          style={styles.iconButton}
        >
          <IconArrowsMaximize size={18} color={tokens.textSecondary} />
        </Pressable>
      </View>
      <View
        style={[styles.frame, { height }]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {unavailable ? (
          <Text style={styles.placeholderText}>Unable to load {htmlRender.title}</Text>
        ) : url === null || NativePageView === null ? (
          <ActivityIndicator size="small" color={tokens.textSecondary} />
        ) : (
          <NativePageView
            url={url}
            style={StyleSheet.absoluteFill}
            onPageFailed={() => setFailed(true)}
            onContentHeight={(event) => setContentHeight(event.nativeEvent.height)}
            onOpenLink={openLink}
          />
        )}
      </View>
      <Modal
        visible={open}
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {htmlRender.title}
            </Text>
            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close page"
              hitSlop={8}
              style={styles.iconButton}
            >
              <IconX size={22} color={tokens.text} />
            </Pressable>
          </View>
          {open && url !== null && NativePageView !== null ? (
            <NativePageView url={url} scrollable style={styles.viewerPage} onOpenLink={openLink} />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    marginTop: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  title: { flex: 1, color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  frame: { alignItems: "center", justifyContent: "center", backgroundColor: tokens.bg },
  placeholderText: { color: tokens.textSecondary, fontSize: 13, paddingHorizontal: 12 },
  viewer: { flex: 1, backgroundColor: tokens.bg },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 4,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  viewerTitle: { flex: 1, color: tokens.text, fontSize: 16, fontWeight: "600" },
  viewerPage: { flex: 1 },
});
