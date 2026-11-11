import {
  profileVoiceCallSettings,
  VOICE_CALL_DEFAULT_LANGUAGES,
  VOICE_CALL_LANGUAGES_MAX_CHARS,
  VOICE_CALL_QUIET_MINUTES,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  type EnvironmentId,
  type VoiceCallSettingsInput,
} from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  CURATED_VOICES,
  GEMINI_KEYS_URL,
  GEMINI_KEYS_URL_LABEL,
  hasVoiceCallKey,
  MORE_VOICES,
  VOICE_CALL_KEY_ORIGIN_LABEL,
  VOICE_CALL_KEY_PLACEMENT,
  voiceApiKeyCheckLine,
  type VoiceCallCheck,
} from "@hbots/personal-client/conversation/voice/voiceCallApi";
import { IconCheck, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react-native";
import * as Redacted from "effect/Redacted";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecretDraft } from "../platform/useSecretDraft";
import { useSecureScreen } from "../platform/secureScreen";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { hbotsVoice } from "../voice/hbotsVoice";
import {
  createVoiceSamplePlayer,
  voiceSampleProblemLine,
  type FetchSample,
  type VoiceSampleState,
} from "../voice/voiceSamplePlayer";
import { Field, PrimaryButton, Row, Section, SectionNote, TextButton } from "./SettingsUi";

const CHECK_COLOR: Record<VoiceCallCheck["tone"], string> = {
  pending: tokens.textSecondary,
  ok: tokens.working,
  rejected: tokens.danger,
  empty: tokens.reviewText,
  quiet: tokens.textSecondary,
};

export function VoiceSettingsSection({ native }: { readonly native: NativePersonal }) {
  const environmentId = native.environmentId as EnvironmentId;
  useSecureScreen(true);
  const profile = native.bots.usePersonalProfile(environmentId);
  const savedSecrets = native.secrets.useSavedSecrets(environmentId);
  const setProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const createSecret = native.client.useAtomCommand(native.secrets.personalSecretCreate, {
    reportFailure: false,
  });
  const deleteSecret = native.client.useAtomCommand(native.secrets.personalSecretDelete, {
    reportFailure: false,
  });
  const checkKey = native.client.useAtomCommand(native.voice.personalVoiceCallCheckKey, {
    reportFailure: false,
  });
  const requestSample = native.client.useAtomCommand(native.voice.personalVoiceCallSample, {
    reportFailure: false,
  });

  const settings = profileVoiceCallSettings(profile.data ?? {});
  const hasKey = hasVoiceCallKey(savedSecrets.data?.secrets ?? null);

  const [draft, setDraft, clearDraft] = useSecretDraft();
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCallCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"voice" | "quiet" | "languages" | null>(null);
  const [languagesDraft, setLanguagesDraft] = useState(settings.languages);

  const runCheck = () => {
    setCheck({ tone: "pending", text: "Checking this key…" });
    void checkKey({ environmentId, input: {} }).then((result) => {
      setCheck(
        voiceApiKeyCheckLine(
          result._tag === "Success" ? result.value : { status: "unavailable", origin: "" },
        ),
      );
    });
  };

  useEffect(() => {
    /* eslint-disable react/set-state-in-effect -- the check follows the key appearing or going */
    if (!hasKey) {
      setCheck(null);
      return;
    }
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- only when the key appears or goes
    runCheck();
    /* eslint-enable react/set-state-in-effect */
  }, [hasKey, environmentId]);

  const patch = (input: VoiceCallSettingsInput) => {
    void setProfile({ environmentId, input: { voiceCalls: input } }).then((result) => {
      setProblem(commandFailureMessage(result, "Could not save that. Try again."));
    });
  };

  const saveKey = () => {
    const value = draft.trim();
    if (value.length === 0) return;
    setBusy(true);
    setProblem(null);
    void createSecret({
      environmentId,
      input: {
        name: VOICE_CALL_SECRET_NAME,
        label: "Gemini API key",
        value: Redacted.make(value),
        shared: true,
        mode: "brokered",
        origins: [VOICE_CALL_SECRET_ORIGIN],
        placement: { ...VOICE_CALL_KEY_PLACEMENT },
      },
    }).then((result) => {
      setBusy(false);
      clearDraft();
      setRevealed(false);
      setEditing(false);
      setProblem(commandFailureMessage(result, "Could not save this key. Try again."));
      if (result._tag === "Success") runCheck();
    });
  };

  const removeKey = () => {
    setBusy(true);
    void deleteSecret({ environmentId, input: { name: VOICE_CALL_SECRET_NAME } }).then((result) => {
      setBusy(false);
      setCheck(null);
      setProblem(commandFailureMessage(result, "Could not remove that key."));
    });
  };

  const fetchSample = useMemo<FetchSample>(
    () => async (voiceName) => {
      const result = await requestSample({ environmentId, input: { voiceName } });
      if (result._tag !== "Success" || result.value === undefined) return null;
      return { base64: result.value.base64 };
    },
    [environmentId, requestSample],
  );

  const keyMissing = !hasKey;
  const showForm = editing || keyMissing;

  return (
    <>
      <Section label="Voice calls">
        <View style={styles.keyBlock}>
          <Text style={styles.keyTitle} maxFontSizeMultiplier={1.4}>
            Gemini API key
          </Text>
          {showForm ? (
            <>
              <Text style={styles.keyNote} maxFontSizeMultiplier={1.4}>
                {editing ? "Enter a new key to replace the saved one. " : ""}
                Add your Gemini API key to call your bots. Keys come from{" "}
                <Text
                  style={styles.link}
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(GEMINI_KEYS_URL)}
                >
                  {GEMINI_KEYS_URL_LABEL}
                </Text>
                .
              </Text>
              <Field
                label="Gemini API key"
                value={draft}
                onChangeText={setDraft}
                placeholder="AIza…"
                secure={!revealed}
                autoCapitalize="none"
                autoComplete="new-password"
                editable={!busy}
              />
              <View style={styles.buttons}>
                <TextButton
                  label={revealed ? "Hide" : "Show"}
                  onPress={() => setRevealed((previous) => !previous)}
                />
                {keyMissing ? null : (
                  <TextButton
                    label="Cancel"
                    onPress={() => {
                      setEditing(false);
                      clearDraft();
                      setRevealed(false);
                    }}
                  />
                )}
              </View>
              <PrimaryButton
                label="Save key"
                onPress={saveKey}
                busy={busy}
                disabled={draft.trim().length === 0}
              />
            </>
          ) : (
            <>
              <Text style={styles.keyNote} maxFontSizeMultiplier={1.4}>
                Saved. The value stays on the server and is never shown again. It can only be sent
                to {VOICE_CALL_KEY_ORIGIN_LABEL}.
              </Text>
              <View style={styles.buttons}>
                <TextButton label="Replace" onPress={() => setEditing(true)} disabled={busy} />
                <TextButton label="Remove" onPress={removeKey} destructive disabled={busy} />
              </View>
            </>
          )}
          {check === null ? null : (
            <Text
              accessibilityRole="text"
              style={[styles.keyNote, { color: CHECK_COLOR[check.tone] }]}
              maxFontSizeMultiplier={1.4}
            >
              {check.text}
            </Text>
          )}
          {problem === null ? null : (
            <Text accessibilityRole="alert" style={styles.problem} maxFontSizeMultiplier={1.4}>
              {problem}
            </Text>
          )}
        </View>
        <Row
          title="Voice"
          hint="How your bots sound on calls"
          value={settings.voiceName}
          onPress={() => setSheet("voice")}
        />
        <Row
          title="Hang up when quiet"
          hint="Ends a call nobody is talking on"
          value={`After ${settings.quietHangupMinutes} min`}
          onPress={() => setSheet("quiet")}
        />
        <Row
          title="Languages I speak"
          hint="The voice reads unclear words as one of these"
          value={settings.languages}
          onPress={() => {
            setLanguagesDraft(settings.languages);
            setSheet("languages");
          }}
          last
        />
      </Section>
      <SectionNote>
        Calls run on Google Gemini Live. Google hears the call, including the replies it reads to
        you. Calls follow the languages you list above.
      </SectionNote>

      {sheet === "voice" ? (
        <VoiceSheet
          selected={settings.voiceName}
          samplesAvailable={hasKey}
          fetchSample={fetchSample}
          onPick={(name) => patch({ voiceName: name })}
          onClose={() => setSheet(null)}
        />
      ) : null}

      <SheetShell
        visible={sheet === "quiet"}
        title="Hang up when quiet"
        onClose={() => setSheet(null)}
      >
        {VOICE_CALL_QUIET_MINUTES.map((minutes) => (
          <Pressable
            key={minutes}
            accessibilityRole="radio"
            accessibilityState={{ checked: settings.quietHangupMinutes === minutes }}
            onPress={() => {
              patch({ quietHangupMinutes: minutes });
              setSheet(null);
            }}
            style={styles.choice}
          >
            <Text style={styles.choiceLabel}>After {minutes} min</Text>
            {settings.quietHangupMinutes === minutes ? (
              <IconCheck size={20} color={tokens.working} strokeWidth={2} />
            ) : null}
          </Pressable>
        ))}
      </SheetShell>

      <SheetShell
        visible={sheet === "languages"}
        title="Languages I speak"
        onClose={() => setSheet(null)}
        inline
      >
        <Text style={styles.keyNote} maxFontSizeMultiplier={1.4}>
          A call hears you better when it knows what to expect. List every language you might speak
          on a call, separated by commas.
        </Text>
        <Field
          label="Languages I speak"
          value={languagesDraft}
          onChangeText={setLanguagesDraft}
          placeholder={VOICE_CALL_DEFAULT_LANGUAGES}
          maxLength={VOICE_CALL_LANGUAGES_MAX_CHARS}
        />
        <PrimaryButton
          label="Save"
          onPress={() => {
            patch({
              languages:
                languagesDraft.trim() === "" ? VOICE_CALL_DEFAULT_LANGUAGES : languagesDraft,
            });
            setSheet(null);
          }}
        />
      </SheetShell>
    </>
  );
}

function VoiceSheet({
  selected,
  samplesAvailable,
  fetchSample,
  onPick,
  onClose,
}: {
  readonly selected: string;
  readonly samplesAvailable: boolean;
  readonly fetchSample: FetchSample;
  readonly onPick: (name: string) => void;
  readonly onClose: () => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const player = useMemo(
    () => createVoiceSamplePlayer({ sink: hbotsVoice, fetchSample }),
    [fetchSample],
  );
  const [sample, setSample] = useState<VoiceSampleState>(() => player.state());
  useEffect(() => player.subscribe(setSample), [player]);
  useEffect(() => () => player.dispose(), [player]);

  const row = (name: string, note: string | null) => {
    const playing = sample.playingVoice === name;
    const loading = sample.loadingVoice === name;
    const failure = voiceSampleProblemLine(sample, name);
    return (
      <View key={name} style={styles.voiceRow}>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === name }}
          onPress={() => {
            player.stop();
            onPick(name);
            onClose();
          }}
          style={styles.voiceName}
        >
          <Text style={styles.choiceLabel} numberOfLines={1}>
            {name}
          </Text>
          {note === null ? null : (
            <Text style={styles.voiceNote} numberOfLines={1}>
              {note}
            </Text>
          )}
          {selected === name ? (
            <IconCheck size={20} color={tokens.working} strokeWidth={2} />
          ) : null}
        </Pressable>
        {samplesAvailable ? (
          <View style={styles.sampleColumn}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing ? `Stop the ${name} sample` : `Play the ${name} sample`}
              accessibilityState={{ selected: playing, busy: loading }}
              onPress={() => player.toggle(name)}
              style={[styles.sampleButton, playing ? styles.sampleButtonOn : null]}
            >
              {loading ? (
                <ActivityIndicator size="small" color={tokens.text} />
              ) : playing ? (
                <IconPlayerStop size={18} color={tokens.bg} strokeWidth={1.75} />
              ) : (
                <IconPlayerPlay size={18} color={tokens.text} strokeWidth={1.75} />
              )}
            </Pressable>
            {failure === null ? null : (
              <Text accessibilityRole="alert" style={styles.sampleProblem}>
                {failure}
              </Text>
            )}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SheetShell visible title="Voice" onClose={onClose}>
      <Text style={styles.keyNote} maxFontSizeMultiplier={1.4}>
        {samplesAvailable
          ? "Tap play to hear a voice, or tap the name to use it on every call."
          : "Tap a voice to use it on every call."}
      </Text>
      {CURATED_VOICES.map((voice) => row(voice.name, voice.note))}
      {showMore ? MORE_VOICES.map((name) => row(name, null)) : null}
      <TextButton
        label={showMore ? "Fewer voices" : `More voices · ${MORE_VOICES.length} more`}
        onPress={() => setShowMore((previous) => !previous)}
      />
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  keyBlock: { padding: 16, gap: 10 },
  keyTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  keyNote: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  link: { color: tokens.text, textDecorationLine: "underline" },
  buttons: { flexDirection: "row", gap: 8 },
  problem: { color: tokens.danger, fontSize: 13 },
  choice: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  choiceLabel: { color: tokens.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  voiceRow: { flexDirection: "row", alignItems: "center", minHeight: 56, gap: 8 },
  voiceName: {
    flex: 1,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
  },
  voiceNote: { color: tokens.textTertiary, fontSize: 13, flexShrink: 1 },
  sampleColumn: { alignItems: "flex-end", gap: 4 },
  sampleButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
  },
  sampleButtonOn: { backgroundColor: tokens.text },
  sampleProblem: { color: tokens.danger, fontSize: 12, maxWidth: 140, textAlign: "right" },
});
