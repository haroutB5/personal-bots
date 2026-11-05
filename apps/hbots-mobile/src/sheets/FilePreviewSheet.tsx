import type { AssetResource } from "@t3tools/contracts";
import {
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

const TEXT_EXTENSIONS =
  /\.(?:txt|md|markdown|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yml|yaml|toml|ini|cfg|log|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|env)$/i;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/**
 * The chat's file sheet. The file's URL is an asset atom, the same path the
 * web viewer uses, so a personal chat resolves it under the Personal project's
 * folder and a project chat under its worktree.
 */
export function FilePreviewSheet({
  native,
  chat,
  visible,
  cwd,
  path,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly visible: boolean;
  readonly cwd: string | null;
  readonly path: string | null;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const absolute = path !== null && /^[\\/]|^~|^[A-Za-z]:[\\/]/u.test(path);
  const readsText = path !== null && TEXT_EXTENSIONS.test(path);
  const resource = useMemo<AssetResource | null>(
    () =>
      visible && path !== null && (cwd !== null || absolute)
        ? {
            _tag: "host-file",
            cwd: cwd ?? "",
            path,
            // The inline route only mints previewable media, HTML and PDF.
            // Text needs the download route, which serves any file type.
            disposition: readsText ? "download" : "inline",
          }
        : null,
    [absolute, cwd, path, readsText, visible],
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
  const state = assetUrlStateFromResult(useAtomValue(urlAtom), native.httpBaseUrl);
  const url = state._tag === "Success" ? state.url : null;

  useEffect(() => {
    let live = true;
    setText(null);
    setFetchError(null);
    if (url === null || path === null || !TEXT_EXTENSIONS.test(path)) return;
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!live) return;
        if (!response.ok) {
          setFetchError("Couldn't read that file.");
          return;
        }
        setText(await response.text());
      } catch {
        if (live) setFetchError("Couldn't open that file.");
      }
    })();
    return () => {
      live = false;
    };
  }, [path, url]);

  const name = path === null ? "" : (path.split(/[\\/]/).at(-1) ?? path);
  const error =
    fetchError ??
    (state._tag === "Failure"
      ? state.protectedFile === true
        ? "This file holds credentials or machine state, so it is never shown."
        : state.notFound === true
          ? "Couldn't open this file. It may have moved or been deleted."
          : "Couldn't open that file."
      : null);
  const canShowImage = path !== null && IMAGE_EXTENSIONS.test(path);
  const wrongKind =
    state._tag === "Success" && path !== null && !canShowImage && !TEXT_EXTENSIONS.test(path)
      ? "This file can't be shown on the phone."
      : null;

  return (
    <SheetShell visible={visible} title={name} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.path} numberOfLines={2}>
          {path ?? ""}
        </Text>
        {state._tag === "Loading" ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.textSecondary} />
          </View>
        ) : error !== null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : wrongKind !== null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {wrongKind}
          </Text>
        ) : text !== null ? (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.code} selectable>
              {text}
            </Text>
          </ScrollView>
        ) : url !== null && canShowImage ? (
          <Image
            source={{ uri: url }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={name}
          />
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.textSecondary} />
          </View>
        )}
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 10, maxHeight: 620 },
  path: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  center: { paddingVertical: 32, alignItems: "center" },
  error: { color: tokens.error, fontSize: 14, lineHeight: 20 },
  scroll: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  scrollContent: { padding: 12 },
  code: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  image: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
});
