import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

const TEXT_EXTENSIONS =
  /\.(?:txt|md|markdown|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yml|yaml|toml|ini|cfg|log|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|env)$/i;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

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
  const createUrl = native.client.useAtomCommand(chat.assets.createUrl as never, {
    reportFailure: false,
  }) as (target: {
    readonly environmentId: string;
    readonly input: {
      readonly resource: {
        readonly _tag: "host-file";
        readonly cwd: string;
        readonly path: string;
        readonly disposition: "inline";
      };
    };
  }) => Promise<
    | { readonly _tag: "Success"; readonly value: { readonly relativeUrl: string } }
    | { readonly _tag: "Failure"; readonly cause?: unknown }
  >;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const absolute = path !== null && /^[\/]|^~|^[A-Za-z]:[\\/]/u.test(path);
    if (!visible || path === null || (cwd === null && !absolute)) return;
    setLoading(true);
    setError(null);
    setText(null);
    setUrl(null);
    void (async () => {
      try {
        const result = await createUrl({
          environmentId: native.environmentId,
          input: {
            resource: { _tag: "host-file", cwd: cwd ?? "", path, disposition: "inline" },
          },
        });
        if (!live) return;
        if (result._tag !== "Success") {
          const cause = squashAtomCommandFailure(result as never);
          setError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Couldn't open that file.",
          );
          return;
        }
        const resolved = new URL(result.value.relativeUrl, native.httpBaseUrl).toString();
        setUrl(resolved);
        if (TEXT_EXTENSIONS.test(path)) {
          const response = await fetch(resolved, { cache: "no-store" });
          if (!live) return;
          if (!response.ok) {
            setError("Couldn't read that file.");
            return;
          }
          setText(await response.text());
        } else if (!IMAGE_EXTENSIONS.test(path)) {
          setError("This file can't be shown on the phone.");
        }
      } catch {
        if (live) setError("Couldn't open that file.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [chat.assets, createUrl, cwd, native, path, visible]);

  const name = path === null ? "" : (path.split(/[\\/]/).at(-1) ?? path);
  return (
    <SheetShell visible={visible} title={name} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.path} numberOfLines={2}>
          {path ?? ""}
        </Text>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.textSecondary} />
          </View>
        ) : error !== null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : text !== null ? (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.code} selectable>
              {text}
            </Text>
          </ScrollView>
        ) : url !== null ? (
          <Image
            source={{ uri: url }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={name}
          />
        ) : null}
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
