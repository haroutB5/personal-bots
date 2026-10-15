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
 * Settings > Voice calls: which voice the bots speak with and how long a quiet
 * call keeps running. Stored server-side in `personal_meta` under
 * `voiceCalls`; absent means the defaults.
 */
export const VoiceCallSettings = Schema.Struct({
  voiceName: Schema.String,
  quietHangupMinutes: Schema.Literals(VOICE_CALL_QUIET_MINUTES),
});
export type VoiceCallSettings = typeof VoiceCallSettings.Type;

export const DEFAULT_VOICE_CALL_SETTINGS: VoiceCallSettings = {
  voiceName: VOICE_CALL_DEFAULT_VOICE,
  quietHangupMinutes: VOICE_CALL_DEFAULT_QUIET_MINUTES,
};

export const VoiceCallSettingsInput = Schema.Struct({
  voiceName: Schema.optional(Schema.String),
  quietHangupMinutes: Schema.optional(Schema.Literals(VOICE_CALL_QUIET_MINUTES)),
});
export type VoiceCallSettingsInput = typeof VoiceCallSettingsInput.Type;

/** The settings a profile carries, with the defaults filled in. */
export const profileVoiceCallSettings = (profile: {
  readonly voiceCalls?: VoiceCallSettings | undefined;
}): VoiceCallSettings => profile.voiceCalls ?? DEFAULT_VOICE_CALL_SETTINGS;

/**
 * Whether a bot may be called. Optional on the wire only so a client built
 * before this feature still decodes `personalBots.list`; read it through this,
 * which treats an older server's silence as off.
 */
export const botAllowsVoiceCalls = (bot: {
  readonly allowVoiceCalls?: boolean | undefined;
}): boolean => bot.allowVoiceCalls === true;
