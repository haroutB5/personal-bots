import * as Schema from "effect/Schema";

/**
 * The voice-call settings that both the profile (`personalBots.ts`) and the
 * call contract (`personalVoiceCalls.ts`) need. It lives on its own so neither
 * of those imports the other: `personalVoiceCalls.ts` names a `PersonalBotId`
 * and would otherwise close a cycle with `personalBots.ts`.
 */

/** Quiet-hangup choices, in minutes. */
export const VOICE_CALL_QUIET_MINUTES = [1, 2, 5] as const;
export type VoiceCallQuietMinutes = (typeof VOICE_CALL_QUIET_MINUTES)[number];
export const VOICE_CALL_DEFAULT_QUIET_MINUTES: VoiceCallQuietMinutes = 2;

export const VOICE_CALL_DEFAULT_VOICE = "Charon";

/**
 * Settings > Voice calls > "Languages I speak" (Harout, 16 Oct 2026). One free
 * text line naming the languages the owner speaks, "English" by default, which
 * goes into the call's system instruction: on a call Harout said "Barev" and
 * the voice heard "pare 20 pesos" and answered in Spanish, so the voice is told
 * what it may reasonably hear and never to drift into another language.
 */
export const VOICE_CALL_DEFAULT_LANGUAGES = "English";
/** Longest the languages line may be, so a paste cannot bloat every instruction. */
export const VOICE_CALL_LANGUAGES_MAX_CHARS = 120;

/** Gemini Live's prebuilt voices. Twenty-two more than the eight Settings offers. */
export const VOICE_CALL_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;
export type VoiceCallVoice = (typeof VOICE_CALL_VOICES)[number];

/** True when the name is one Gemini Live offers. Case-sensitive, as Google is. */
export const isVoiceCallVoice = (name: string): name is VoiceCallVoice =>
  (VOICE_CALL_VOICES as ReadonlyArray<string>).includes(name);

/**
 * The saved key a call runs on. One source of truth: the hbots secret store.
 * The Settings row shows the state of this very key and its Save/Replace uses
 * the ordinary API-key form, never a second copy.
 */
export const VOICE_CALL_SECRET_NAME = "GEMINI_API_KEY";
/** The only origin that key may be sent to. */
export const VOICE_CALL_SECRET_ORIGIN = "https://generativelanguage.googleapis.com";
/**
 * The header Gemini takes the plain key in. The key is saved brokered with
 * this as its extra placement header, so the server can use it without ever
 * putting it in a URL, a body or a log.
 */
export const VOICE_CALL_SECRET_HEADER = "x-goog-api-key";

/**
 * Settings > Voice calls: which voice the bots speak with, how long a quiet
 * call keeps running, and which languages the owner speaks. Stored server-side
 * in `personal_meta` under `voiceCalls`; absent means the defaults.
 *
 * `languages` is optional on purpose: a row written before this field existed
 * (`{voiceName, quietHangupMinutes}`) still decodes, and an older client still
 * decodes a profile that carries it. Read it through
 * {@link profileVoiceCallSettings}, which fills the default in.
 */
export const VoiceCallSettings = Schema.Struct({
  voiceName: Schema.String,
  quietHangupMinutes: Schema.Literals(VOICE_CALL_QUIET_MINUTES),
  languages: Schema.optional(Schema.String),
});
export type VoiceCallSettings = typeof VoiceCallSettings.Type;

/** The settings with every field present, as the server and the UI read them. */
export interface ResolvedVoiceCallSettings {
  readonly voiceName: string;
  readonly quietHangupMinutes: VoiceCallQuietMinutes;
  readonly languages: string;
}

export const DEFAULT_VOICE_CALL_SETTINGS: ResolvedVoiceCallSettings = {
  voiceName: VOICE_CALL_DEFAULT_VOICE,
  quietHangupMinutes: VOICE_CALL_DEFAULT_QUIET_MINUTES,
  languages: VOICE_CALL_DEFAULT_LANGUAGES,
};

export const VoiceCallSettingsInput = Schema.Struct({
  voiceName: Schema.optional(Schema.String),
  quietHangupMinutes: Schema.optional(Schema.Literals(VOICE_CALL_QUIET_MINUTES)),
  languages: Schema.optional(Schema.String),
});
export type VoiceCallSettingsInput = typeof VoiceCallSettingsInput.Type;

/** The settings a profile carries, with the defaults filled in. */
export const profileVoiceCallSettings = (profile: {
  readonly voiceCalls?: VoiceCallSettings | undefined;
}): ResolvedVoiceCallSettings => {
  const stored = profile.voiceCalls;
  if (stored === undefined) return DEFAULT_VOICE_CALL_SETTINGS;
  return {
    voiceName: stored.voiceName,
    quietHangupMinutes: stored.quietHangupMinutes,
    languages: stored.languages ?? VOICE_CALL_DEFAULT_LANGUAGES,
  };
};

/**
 * Whether a bot may be called. Optional on the wire only so a client built
 * before this feature still decodes `personalBots.list`; read it through this,
 * which treats an older server's silence as off.
 */
export const botAllowsVoiceCalls = (bot: {
  readonly allowVoiceCalls?: boolean | undefined;
}): boolean => bot.allowVoiceCalls === true;
