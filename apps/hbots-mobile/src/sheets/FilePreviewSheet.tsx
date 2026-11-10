import type { AssetResource } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import {
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { decodeFilePreviewText } from "@t3tools/shared/filePreview";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { FileOpenRequest } from "../chat/fileOpenRequest";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  filePreviewErrorText,
  filePreviewRoute,
  filePreviewState,
  type FilePreviewSource,
  type FileTextRead,
} from "./filePreviewModel";
import { SheetShell } from "./SheetShell";

const TEXT_READ_TIMEOUT_MS = 15_000;

type TextFetchState =
  | {
      readonly url: string;
      readonly status: "ready";
      readonly text: string;
      readonly truncated: boolean;
    }
  | { readonly url: string; readonly status: "binary" }
  | { readonly url: string; readonly status: "error" }
  | { readonly url: string; readonly status: "timed-out" };

/**
 * Downloads a text file from its signed URL and decodes it with the same 1 MiB
 * cap and binary check the web viewer uses. The URL expires on its own, so a
 * retry mints a fresh one.
 */
function useFileText(url: string | null): FileTextRead {
  const [state, setState] = useState<TextFetchState | null>(null);
  useEffect(() => {
    if (url === null) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEXT_READ_TIMEOUT_MS);
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      })
      .then((bytes) => {
        if (!active) return;
        try {
          const decoded = decodeFilePreviewText(bytes);
          setState({ url, status: "ready", text: decoded.text, truncated: decoded.truncated });
        } catch {
          setState({ url, status: "binary" });
        }
      })
      .catch(() => {
        if (!active) return;
        setState({ url, status: controller.signal.aborted ? "timed-out" : "error" });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [url]);

  if (url === null || state === null || state.url !== url) return { _tag: "Pending" };
  switch (state.status) {
    case "ready":
      return { _tag: "Loaded", text: state.text, truncated: state.truncated };
    case "binary":
      return { _tag: "Binary" };
    case "error":
      return { _tag: "Failed" };
    case "timed-out":
      return { _tag: "TimedOut" };
  }
}

/**
 * The chat's file sheet. A bot's message links the file, and the server grants
 * that one read because the message links it. Both routes mint a per-message
 * asset URL; text then downloads and decodes it, images show it inline.
 */
export function FilePreviewSheet({
  native,
  chat,
  visible,
  threadId,
  request,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly visible: boolean;
  readonly threadId: string;
  readonly request: FileOpenRequest | null;
  readonly onClose: () => void;
}) {
  const route = request === null ? "unsupported" : filePreviewRoute(request.path);
  const resource = useMemo<AssetResource | null>(
    () =>
      visible && request !== null && route !== "unsupported"
        ? {
            _tag: "message-file",
            threadId: ThreadId.make(threadId),
            messageId: request.messageId,
            path: request.path,
            disposition: route === "text" ? "download" : "inline",
          }
        : null,
    [request, route, threadId, visible],
  );
  const urlAtom = useMemo(
    () =>
      resource === null
        ? EMPTY_ASSET_URL_ATOM
        : chat.assets.createUrl({
            environmentId: native.environmentId,
            input: { resource },
          }),
    [chat.assets, native.environmentId, resource],
  );
  const asset = assetUrlStateFromResult(useAtomValue(urlAtom), native.httpBaseUrl);
  const refreshAsset = useAtomRefresh(urlAtom);

  const textUrl = route === "text" && asset._tag === "Success" ? asset.url : null;
  const read = useFileText(textUrl);

  // Retry mints a new signed URL; its token differs, so the text effect runs again.
  const retry = () => refreshAsset();

  const source: FilePreviewSource =
    route === "text"
      ? { _tag: "Text", asset, read }
      : route === "image"
        ? { _tag: "Image", asset }
        : { _tag: "Unsupported" };
  const preview = filePreviewState({ path: request?.path ?? null, source });

  const path = request?.path ?? null;
  const name = path === null ? "" : (path.split(/[\\/]/).at(-1) ?? path);

  const content = (() => {
    switch (preview._tag) {
      case "Loading":
        return (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.textSecondary} />
          </View>
        );
      case "Text":
        return (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.code} selectable>
              {preview.text}
            </Text>
            {read._tag === "Loaded" && read.truncated ? (
              <Text style={styles.truncated}>Showing the first 1 MB of this file.</Text>
            ) : null}
          </ScrollView>
        );
      case "Image":
        return (
          <Image
            source={{ uri: preview.url }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={name}
          />
        );
      case "Unsupported":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This file can&apos;t be shown on the phone.
          </Text>
        );
      case "Denied":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This file holds credentials or machine state, so it is never shown.
          </Text>
        );
      case "Error":
        return (
          <View style={styles.center}>
            <Text style={styles.error} accessibilityRole="alert">
              {filePreviewErrorText(preview.reason)}
            </Text>
            <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        );
      default:
        return assertNever(preview);
    }
  })();

  return (
    <SheetShell visible={visible} title={name} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.path} numberOfLines={2}>
          {path ?? ""}
        </Text>
        {content}
      </View>
    </SheetShell>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled file preview state: ${JSON.stringify(value)}`);
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 10, maxHeight: 620 },
  path: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  center: { paddingVertical: 32, alignItems: "center", gap: 12 },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  error: { color: tokens.error, fontSize: 14, lineHeight: 20, textAlign: "center" },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  retryText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  scroll: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  scrollContent: { padding: 12 },
  code: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  truncated: {
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: 10,
  },
  image: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
});
