import type { EnvironmentId, ProviderCatalogEntry } from "@t3tools/contracts";
import {
  CATALOG_FILTERS,
  deriveBuiltInCatalogEntries,
  partitionCatalog,
  withLiveAdded,
  type CatalogFilter,
} from "@hbots/personal-client/settings/catalogModel";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { Notice, Row, Section, SectionNote, SettingsPage, TextButton } from "./SettingsUi";

export function AddProviderScreen({
  native,
  onBack,
  onOpenProvider,
  onOpenCatalog,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
  readonly onOpenProvider: (instanceId: string) => void;
  readonly onOpenCatalog: (catalogId: string) => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const providers = native.useProviders();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [refresh, setRefresh] = useState(false);
  const catalog = native.providers.useProviderCatalog(environmentId, refresh);
  const builtIns = deriveBuiltInCatalogEntries(providers);
  const entries = mergeEntries(catalog.data?.entries ?? [], builtIns);
  const live = withLiveAdded(entries, providers);
  const partition = partitionCatalog(live, filter, query);
  const failed = catalog.error !== null && entries.length === 0;

  return (
    <SettingsPage title="Add provider" onBack={onBack}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={`Search ${live.length} providers`}
        placeholderTextColor={tokens.textTertiary}
        accessibilityLabel="Search providers"
        autoCapitalize="none"
        style={styles.search}
      />
      <View
        style={styles.chips}
        accessibilityRole="radiogroup"
        accessibilityLabel="Filter providers"
      >
        {CATALOG_FILTERS.map((entry) => {
          const selected = entry.id === filter;
          return (
            <Pressable
              key={entry.id}
              onPress={() => setFilter(entry.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={entry.label}
              style={[styles.chip, selected ? styles.chipSelected : null]}
            >
              <Text
                style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}
                maxFontSizeMultiplier={1.3}
              >
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {failed ? (
        <>
          <Notice tone="danger">
            Couldn't load the full list. Showing the built in providers.
          </Notice>
          <TextButton label="Try again" onPress={() => setRefresh(!refresh)} />
        </>
      ) : null}

      {partition.mode === "sections" ? (
        <>
          {partition.popular.length === 0 ? null : (
            <Section label="Popular">
              {partition.popular.map((entry, index) => (
                <CatalogRow
                  key={entry.catalogId}
                  entry={entry}
                  last={index === partition.popular.length - 1}
                  onPress={() => open(entry)}
                />
              ))}
            </Section>
          )}
          <Section label="All providers, A to Z">
            {partition.allAtoZ.map((entry, index) => (
              <CatalogRow
                key={entry.catalogId}
                entry={entry}
                last={index === partition.allAtoZ.length - 1}
                onPress={() => open(entry)}
              />
            ))}
          </Section>
        </>
      ) : (
        <Section label={partition.title}>
          {partition.items.length === 0 ? (
            partition.mode === "search" ? (
              <Row
                title={`Nothing called "${partition.query}"`}
                hint="This list is every agent in the ACP registry, checked daily. One that isn't on it can't run in hbots yet."
              />
            ) : (
              <Row title="No providers in this filter." />
            )
          ) : (
            partition.items.map((entry, index) => (
              <CatalogRow
                key={entry.catalogId}
                entry={entry}
                last={index === partition.items.length - 1}
                onPress={() => open(entry)}
              />
            ))
          )}
        </Section>
      )}
      <SectionNote>
        Built in providers are made and tested for hbots. The rest come from the ACP registry, an
        open list of coding agents. hbots runs them the same way, but the team hasn't tested each
        one.
      </SectionNote>
    </SettingsPage>
  );

  function open(entry: ProviderCatalogEntry) {
    if (entry.added !== null) {
      onOpenProvider(entry.added.instanceId);
    } else {
      onOpenCatalog(entry.catalogId);
    }
  }
}

function CatalogRow({
  entry,
  onPress,
  last,
}: {
  readonly entry: ProviderCatalogEntry;
  readonly onPress: () => void;
  readonly last: boolean;
}) {
  return (
    <Row
      title={entry.name}
      hint={[entry.publisher, entry.cost.label].filter((part) => part.length > 0).join(" · ")}
      value={entry.added === null ? undefined : "Added"}
      onPress={onPress}
      last={last}
    />
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
  search: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontSize: 15,
    paddingHorizontal: 12,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chip: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  chipSelected: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  chipLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  chipLabelSelected: { color: tokens.primaryText },
});
