import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { NewTeamForm } from "./NewTeamForm";
import { setTeamNotice, type TeamNotice } from "./teamScreenModel";

/**
 * /bots/teams/new: the "+" menu's New team. A name, an optional leader and
 * optional first members; on success it lands on the team screen, which says
 * what happened.
 */
export function NewTeamScreen({
  native,
  onBack,
  onCreated,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
  readonly onCreated: () => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const profile = native.bots.usePersonalProfile(native.environmentId);
  const loaded = list.data !== null && profile.data !== null;
  const error = list.error !== null || profile.error !== null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="New team" onBack={onBack} />
      {!loaded ? (
        <View style={styles.state}>
          <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
            {error ? "Couldn't load your bots and teams." : "Loading your bots…"}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
          keyboardShouldPersistTaps="handled"
        >
          <NewTeamForm
            native={native}
            bots={list.data!.bots}
            customTeams={profile.data!.customTeams ?? []}
            onCreated={(notice: TeamNotice) => {
              setTeamNotice(notice);
              onCreated();
            }}
            onCancel={onBack}
          />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  scroll: { flex: 1 },
  state: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  stateText: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21, textAlign: "center" },
});
