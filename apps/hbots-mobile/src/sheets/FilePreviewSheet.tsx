import type { AssetResource } from "@t3tools/contracts";
import {
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
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
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  filePreviewErrorText,
  filePreviewState,
  isTextFilePath,
  type FileTextRead,
} from "./filePreviewModel";
import { SheetShell } from "./SheetShell";

const TEXT_READ_TIMEOUT_MS = 15_000;

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
  const resource = useMemo<AssetResource | null>(
    () =>
      visible && path !== null && cwd !== null
        ? {
            _tag: "draft-workspace-file",
            cwd,
            path,
          }
        : null,
    [cwd, path, visible],
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
  const url = asset._tag === "Success" ? asset.url : null;
  const refreshAsset = useAtomRefresh(urlAtom);
  const [attempt, setAttempt] = useState(0);
  const [textRead, setTextRead] = useState<{
    readonly key: string;
    readonly state: FileTextRead;
  }>({ key: "", state: { _tag: "Pending" } });

  const readKey = `${attempt}:${path ?? ""}:${url ?? ""}`;
  const text: FileTextRead = textRead.key === readKey ? textRead.state : { _tag: "Pending" };

  useEffect(() => {
    if (url === null || path === null || !isTextFilePath(path)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEXT_READ_TIMEOUT_MS);
    let live = true;
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!live) return;
        if (!response.ok) {
          setTextRead({ key: readKey, state: { _tag: "Failed" } });
          return;
        }
        const value = await response.text();
        if (live) setTextRead({ key: readKey, state: { _tag: "Loaded", text: value } });
      } catch {
        if (live) {
          setTextRead({
            key: readKey,
            state: { _tag: controller.signal.aborted ? "TimedOut" : "Failed" },
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      live = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [path, readKey, url]);

  // A missing file is remembered by the asset atom. Retry asks it again and
  // starts a fresh read, so a file created after the first look opens here.
  const retry = () => {
    refreshAsset();
    setAttempt((value) => value + 1);
  };

  const name = path === null ? "" : (path.split(/[\\/]/).at(-1) ?? path);
  const preview = filePreviewState({ folder: cwd, path, asset, text });

  const content = (() => {
    switch (preview._tag) {
      case "NoFolder":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This chat has no folder to open files from.
          </Text>
        );
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
  image: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
});
