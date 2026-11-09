import type { EnvironmentId, ProviderCatalogEntry } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  deriveBuiltInCatalogEntries,
  unsupportedReasonCopy,
} from "@hbots/personal-client/settings/catalogModel";
import { downloadLine } from "@hbots/personal-client/settings/providerFacts";
import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import {
  Notice,
  PrimaryButton,
  Row,
  Section,
  SectionNote,
  SettingsPage,
  TextButton,
} from "./SettingsUi";

export function CatalogProviderScreen({
  native,
  catalogId,
  onBack,
  onInstalled,
}: {
  readonly native: NativePersonal;
  readonly catalogId: string;
  readonly onBack: () => void;
  readonly onInstalled: (instanceId: string) => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const providers = native.useProviders();
  const catalog = native.providers.useProviderCatalog(environmentId);
  const addToCatalog = native.client.useAtomCommand(native.providers.addProviderFromCatalog, {
    reportFailure: false,
  });
  const startInstall = native.client.useAtomCommand(native.providers.startProviderInstall, {
    reportFailure: false,
  });
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = mergeEntries(catalog.data?.entries ?? [], deriveBuiltInCatalogEntries(providers));
  const entry = entries.find((candidate) => candidate.catalogId === catalogId) ?? null;

  if (entry === null) {
    return (
      <SettingsPage title="Provider" onBack={onBack}>
        <Section label="Provider">
          <Row title="This provider was not found in the catalogue." last />
        </Section>
      </SettingsPage>
    );
  }

  const install = async () => {
    setBusy(true);
    setError(null);
    const added = await addToCatalog({
      environmentId,
      input: { catalogId: entry.catalogId as never },
    });
    const addFailure =
      added === null
        ? "Not connected to your computer."
        : commandFailureMessage(added, `Couldn't add ${entry.name}.`);
    if (addFailure !== null || added === null || added._tag !== "Success") {
      setError(addFailure ?? `Couldn't add ${entry.name}.`);
      setBusy(false);
      return;
    }
    const instanceId = added.value.instanceId;
    // The server runs the registry prepare during the add, so a registry agent
    // is installed before this call. Only a built-in has a managed install to start.
    if (entry.source === "registry") {
      setBusy(false);
      setSheet(false);
      onInstalled(instanceId);
      return;
    }
    const started = await startInstall({ environmentId, input: { instanceId } });
    const startFailure =
      started === null
        ? "Not connected to your computer."
        : commandFailureMessage(started, `Couldn't start ${entry.name} install.`);
    setBusy(false);
    setSheet(false);
    if (startFailure !== null) {
      setError(startFailure);
      return;
    }
    onInstalled(instanceId);
  };

  const unsupported = entry.supported.ok ? null : unsupportedReasonCopy(entry.supported.reason);

  return (
    <SettingsPage title={entry.name} onBack={onBack}>
      <View style={styles.hero}>
        <View style={styles.tile}>
          <Text style={styles.tileLetter} maxFontSizeMultiplier={1.3}>
            {entry.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle} maxFontSizeMultiplier={1.4}>
            {entry.name}
          </Text>
          <Text style={styles.heroSub} maxFontSizeMultiplier={1.4}>
            {entry.publisher}
            {entry.license.length > 0
              ? ` · ${entry.openSource ? "Open source" : "Closed source"}`
              : ""}
          </Text>
        </View>
      </View>
      {entry.description.length === 0 ? null : <SectionNote>{entry.description}</SectionNote>}

      <Section label="What it costs">
        <Row title={entry.cost.label} hint={entry.cost.detail ?? undefined} last />
      </Section>

      <Section label="Details">
        <Row title="Sign in" value={entry.signInLabel ?? "Shown after install"} />
        {entry.version === null ? null : <Row title="Version" value={entry.version} />}
        <Row title="Download" value={downloadLine(entry.downloadBytes)} />
        <Row
          title="From"
          value={entry.source === "builtIn" ? "Built into hbots" : "ACP registry"}
        />
        <Row title="Licence" value={entry.license.length > 0 ? entry.license : "Not listed"} />
        {entry.website === null && entry.repository === null ? null : (
          <Row
            title="Website"
            value="Visit site"
            onPress={() => {
              const url = entry.website ?? entry.repository;
              if (url !== null) void Linking.openURL(url);
            }}
            last
          />
        )}
      </Section>

      {error === null ? null : <Notice tone="danger">{error}</Notice>}

      {unsupported === null ? (
        <PrimaryButton label={`Install ${entry.name}`} onPress={() => setSheet(true)} />
      ) : (
        <Section label="Can't install from the phone yet">
          <Row title={unsupported.title} hint={unsupported.text} last />
        </Section>
      )}

      <SheetShell visible={sheet} title={`Install ${entry.name}?`} onClose={() => setSheet(false)}>
        <Text style={styles.sheetSub} maxFontSizeMultiplier={1.4}>
          On your laptop, for your bots
        </Text>
        <Fact label="Publisher" value={entry.publisher} />
        <Fact label="Version" value={entry.version ?? "Not reported"} />
        <Fact label="Download" value={downloadLine(entry.downloadBytes)} />
        <Fact
          label="From"
          value={entry.source === "builtIn" ? "Built into hbots" : "ACP registry"}
        />
        <Fact label="Licence" value={entry.license.length > 0 ? entry.license : "Not listed"} />
        <Fact
          label="Checked"
          value={
            entry.sha256Checked
              ? "Checked against the registry's fingerprint before it runs"
              : "No registry fingerprint for this one"
          }
        />
        <Text style={styles.warning} maxFontSizeMultiplier={1.4}>
          Once installed it can do what your bots can: read and change files, run commands and use
          the internet. Install only publishers you trust.
        </Text>
        <View style={styles.buttons}>
          <TextButton label="Cancel" onPress={() => setSheet(false)} />
          <PrimaryButton
            label={busy ? "Starting…" : "Install"}
            onPress={() => void install()}
            busy={busy}
          />
        </View>
      </SheetShell>
    </SettingsPage>
  );
}

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

function mergeEntries(
  catalog: ReadonlyArray<ProviderCatalogEntry>,
  builtIns: ReadonlyArray<ProviderCatalogEntry>,
): ReadonlyArray<ProviderCatalogEntry> {
  const seen = new Set(catalog.map((entry) => entry.catalogId));
  return [...catalog, ...builtIns.filter((entry) => !seen.has(entry.catalogId))];
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8 },
  tile: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  tileLetter: { color: tokens.text, fontSize: 26, fontWeight: "600" },
  heroText: { flex: 1, gap: 2 },
  heroTitle: { color: tokens.text, fontSize: 22, fontWeight: "600" },
  heroSub: { color: tokens.textSecondary, fontSize: 13 },
  sheetSub: { color: tokens.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingTop: 4 },
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
});
