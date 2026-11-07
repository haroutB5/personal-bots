import type {
  ProviderCatalogInstallPlan,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { PrimaryButton, TextButton } from "./SettingsUi";

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      <Text style={styles.factValue} maxFontSizeMultiplier={1.4}>
        {value}
      </Text>
    </View>
  );
}

export function InstallConfirmSheet({
  visible,
  snapshot,
  facts,
  busy,
  onClose,
  onInstall,
}: {
  readonly visible: boolean;
  readonly snapshot: ServerProvider;
  readonly facts: ProviderCatalogInstallPlan | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onInstall: () => void;
}) {
  const label = snapshot.displayName ?? snapshot.driver;
  const publisher = snapshot.publisher ?? "Built into hbots";
  const version = facts?.version ?? snapshot.version ?? "Not reported";
  const download =
    facts?.downloadBytes == null
      ? "Size shown when the download starts"
      : formatBytes(facts.downloadBytes);
  const license = snapshot.license ?? "Not listed";
  return (
    <SheetShell visible={visible} title={`Install ${label}?`} onClose={onClose}>
      <Text style={styles.subtitle} maxFontSizeMultiplier={1.4}>
        On your laptop, for your bots
      </Text>
      <Fact label="Publisher" value={publisher} />
      <Fact label="Version" value={version} />
      <Fact label="Download" value={download} />
      <Fact
        label="From"
        value={snapshot.source === "registry" ? "ACP registry" : "Built into hbots"}
      />
      <Fact label="Licence" value={license} />
      <Fact label="Checked" value="Checked against the registry's fingerprint before it runs" />
      <Text style={styles.warning} maxFontSizeMultiplier={1.4}>
        Once installed it can do what your bots can: read and change files, run commands and use the
        internet. Install only publishers you trust.
      </Text>
      <View style={styles.buttons}>
        <TextButton label="Cancel" onPress={onClose} />
        <PrimaryButton label={busy ? "Starting…" : "Install"} onPress={onInstall} busy={busy} />
      </View>
    </SheetShell>
  );
}

export function ProviderConfirmSheet({
  visible,
  title,
  subtitle,
  body,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <SheetShell visible={visible} title={title} onClose={onClose}>
      <Text style={styles.subtitle} maxFontSizeMultiplier={1.4}>
        {subtitle}
      </Text>
      <Text style={styles.body} maxFontSizeMultiplier={1.5}>
        {body}
      </Text>
      <View style={styles.buttons}>
        <TextButton label="Cancel" onPress={onClose} />
        <PrimaryButton
          label={busy ? "Working…" : confirmLabel}
          onPress={onConfirm}
          busy={busy}
          destructive
        />
      </View>
    </SheetShell>
  );
}

export function RemapSheet({
  visible,
  label,
  models,
  busy,
  onClose,
  onPick,
}: {
  readonly visible: boolean;
  readonly label: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onPick: (model: string) => void;
}) {
  const [selected, setSelected] = useState(models[0]?.slug ?? null);
  return (
    <SheetShell visible={visible} title={`New model for ${label}`} onClose={onClose}>
      {models.length === 0 ? (
        <Text style={styles.body} maxFontSizeMultiplier={1.4}>
          {label} lists no models right now. Check it again in a moment.
        </Text>
      ) : (
        models.slice(0, 3).map((model) => {
          const isSelected = model.slug === selected;
          return (
            <Pressable
              key={model.slug}
              onPress={() => setSelected(model.slug)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={model.name}
              style={[styles.model, isSelected ? styles.modelSelected : null]}
            >
              <Text style={styles.modelName} maxFontSizeMultiplier={1.4}>
                {model.name}
              </Text>
              {models[0]?.slug === model.slug ? (
                <Text style={styles.modelHint} maxFontSizeMultiplier={1.4}>
                  The default
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}
      <View style={styles.buttons}>
        <TextButton label="Cancel" onPress={onClose} />
        <PrimaryButton
          label={busy ? "Switching…" : "Use this model"}
          onPress={() => {
            if (selected !== null) onPick(selected);
          }}
          busy={busy}
          disabled={selected === null}
        />
      </View>
    </SheetShell>
  );
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `About ${Math.max(1, Math.round(mb))} MB`;
}

const styles = StyleSheet.create({
  subtitle: { color: tokens.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingTop: 4 },
  body: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, padding: 16 },
  fact: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  factLabel: { color: tokens.textSecondary, fontSize: 13 },
  factValue: { color: tokens.text, fontSize: 13, flexShrink: 1, textAlign: "right" },
  warning: { color: tokens.needs, fontSize: 13, lineHeight: 19, padding: 16 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", padding: 8 },
  model: {
    marginHorizontal: 16,
    marginVertical: 4,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.raised,
    gap: 2,
  },
  modelSelected: { borderColor: tokens.text, borderWidth: 1 },
  modelName: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  modelHint: { color: tokens.textSecondary, fontSize: 12 },
});
