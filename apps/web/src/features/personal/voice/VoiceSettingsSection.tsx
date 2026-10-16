/**
 * Settings > Voice calls (spec 8): the Gemini key row, the voice picker and the
 * quiet-hangup choice, between Chat and Plugins.
 *
 * The key row behaves exactly like the DeepSeek one in Settings > Providers
 * (masked field, Show, Save key, Cancel, Replace, Remove, and one check line
 * after a save), but the key is stored the way the contract says: an ordinary
 * brokered key in the secret store (`GEMINI_API_KEY`, bound to
 * `generativelanguage.googleapis.com`, sent in the `x-goog-api-key` header), so
 * this row writes through the same secret commands the API-keys screen uses and
 * never reads a value back. The check mints one single-use Live token
 * server-side, so it proves Live access without billing any audio.
 *
 * The voice, the quiet time and the languages are the profile's `voiceCalls`
 * field, written with the ordinary profile command.
 *
 * **Languages I speak** (Harout, 16 Oct 2026) is free text, "English" by
 * default. He said "Barev" on a call, the transcription heard "pare 20 pesos"
 * and the voice answered in Spanish until he complained, so the call's system
 * instruction now names the languages he actually speaks and tells the voice
 * never to drift outside them.
 *
 * @module features/personal/voice/VoiceSettingsSection
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";

import {
  profileVoiceCallSettings,
  VOICE_CALL_DEFAULT_LANGUAGES,
  VOICE_CALL_LANGUAGES_MAX_CHARS,
  VOICE_CALL_QUIET_MINUTES,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  type VoiceCallSettingsInput,
} from "@t3tools/contracts";
import { Check, ChevronRight } from "lucide-react";
import * as Redacted from "effect/Redacted";

import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import { personalProfile, personalProfileSet, usePersonalEnvironmentId } from "../usePersonalBots";
import { personalSecretCreate, personalSecretDelete, useSavedSecrets } from "../useSecretRequests";
import {
  CURATED_VOICES,
  GEMINI_KEYS_URL,
  GEMINI_KEYS_URL_LABEL,
  MORE_VOICES,
  VOICE_CALL_KEY_ORIGIN_LABEL,
  VOICE_CALL_KEY_PLACEMENT,
  type VoiceCallCheck,
  hasVoiceCallKey,
  personalVoiceCallCheckKey,
  voiceApiKeyCheckLine,
} from "./voiceCallApi";

const ROW = "flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left";
const ROW_BUTTON =
  "flex h-9 shrink-0 items-center rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[13px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";
const FIELD =
  "h-11 min-w-0 flex-1 rounded-[11px] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 font-mono text-[15px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

export function VoiceSettingsSection(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const profile = useEnvironmentQuery(
    environmentId === null ? null : personalProfile({ environmentId, input: {} }),
  );
  const savedSecrets = useSavedSecrets(environmentId);
  const setProfile = useAtomCommand(personalProfileSet, { reportFailure: false });
  const createSecret = useAtomCommand(personalSecretCreate, { reportFailure: false });
  const deleteSecret = useAtomCommand(personalSecretDelete, { reportFailure: false });
  const checkKey = useAtomCommand(personalVoiceCallCheckKey, { reportFailure: false });

  const settings = profileVoiceCallSettings(profile.data ?? {});
  const hasKey = hasVoiceCallKey(savedSecrets.data?.secrets ?? null);

  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCallCheck | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [quietOpen, setQuietOpen] = useState(false);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [languagesDraft, setLanguagesDraft] = useState(settings.languages);
  const [problem, setProblem] = useState<string | null>(null);

  const runCheck = () => {
    if (environmentId === null) return;
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
    if (!hasKey) {
      setCheck(null);
      return;
    }
    runCheck();
    // Only when the key appears or disappears: the check is the server's, not
    // something this screen re-runs on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, environmentId]);

  const patch = (input: VoiceCallSettingsInput) => {
    if (environmentId === null) return;
    void setProfile({ environmentId, input: { voiceCalls: input } }).then((result) => {
      setProblem(commandFailureMessage(result, "Could not save that. Try again."));
    });
  };

  const saveKey = () => {
    const value = draft.trim();
    if (value.length === 0 || environmentId === null) return;
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
      setDraft("");
      setRevealed(false);
      setEditing(false);
      setProblem(commandFailureMessage(result, "Could not save this key. Try again."));
      if (result._tag === "Success") runCheck();
    });
  };

  const removeKey = () => {
    if (environmentId === null) return;
    setBusy(true);
    void deleteSecret({ environmentId, input: { name: VOICE_CALL_SECRET_NAME } }).then((result) => {
      setBusy(false);
      setCheck(null);
      setProblem(commandFailureMessage(result, "Could not remove that key."));
    });
  };

  const checkClass =
    check?.tone === "ok"
      ? "text-[var(--personal-live)]"
      : check?.tone === "rejected"
        ? "text-[var(--personal-danger)]"
        : check?.tone === "empty"
          ? "text-[var(--personal-review-text)]"
          : "text-[var(--personal-text-secondary)]";
  const keyMissing = !hasKey;

  return (
    <>
      <ul className="divide-y divide-[var(--personal-border)] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
        <li className="flex flex-col gap-2 px-4 py-3">
          <span className="text-[15px] font-semibold text-[var(--personal-text)]">
            Gemini API key
          </span>
          {!keyMissing && !editing ? (
            <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              Saved. The value stays on the server and is never shown again. It can only be sent to{" "}
              {VOICE_CALL_KEY_ORIGIN_LABEL}.
            </span>
          ) : (
            <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              {editing ? "Enter a new key to replace the saved one. " : null}
              Add your Gemini API key to call your bots. Keys come from{" "}
              <a
                className="underline underline-offset-2"
                href={GEMINI_KEYS_URL}
                rel="noreferrer"
                target="_blank"
              >
                {GEMINI_KEYS_URL_LABEL}
              </a>
              .
            </span>
          )}

          {editing || keyMissing ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  aria-label="Gemini API key"
                  autoComplete="new-password"
                  className={FIELD}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    saveKey();
                  }}
                  placeholder="AIza…"
                  spellCheck={false}
                  type={revealed ? "text" : "password"}
                  value={draft}
                />
                <button
                  type="button"
                  aria-pressed={revealed}
                  onClick={() => setRevealed((previous) => !previous)}
                  className={ROW_BUTTON}
                >
                  {revealed ? "Hide" : "Show"}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || draft.trim().length === 0}
                  onClick={saveKey}
                  className={ROW_BUTTON}
                >
                  Save key
                </button>
                {!keyMissing ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setDraft("");
                      setRevealed(false);
                    }}
                    className={ROW_BUTTON}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(true)}
                className={ROW_BUTTON}
              >
                Replace
              </button>
              <button type="button" disabled={busy} onClick={removeKey} className={ROW_BUTTON}>
                Remove
              </button>
            </div>
          )}

          {check !== null ? (
            <p role="status" className={`text-[13px] ${checkClass}`}>
              {check.text}
            </p>
          ) : null}
          {problem !== null ? (
            <p role="alert" className="text-[13px] text-[var(--personal-danger)]">
              {problem}
            </p>
          ) : null}
        </li>

        <li>
          <button type="button" onClick={() => setVoiceOpen(true)} className={ROW}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold text-[var(--personal-text)]">Voice</span>
              <span className="text-[13px] text-[var(--personal-text-secondary)]">
                How your bots sound on calls
              </span>
            </span>
            <span className="text-[15px] text-[var(--personal-text-secondary)]">
              {settings.voiceName}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-5 text-[var(--personal-text-tertiary)]"
            />
          </button>
        </li>

        <li>
          <button type="button" onClick={() => setQuietOpen(true)} className={ROW}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold text-[var(--personal-text)]">
                Hang up when quiet
              </span>
              <span className="text-[13px] text-[var(--personal-text-secondary)]">
                Ends a call nobody is talking on
              </span>
            </span>
            <span className="text-[15px] text-[var(--personal-text-secondary)]">
              After {settings.quietHangupMinutes} min
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-5 text-[var(--personal-text-tertiary)]"
            />
          </button>
        </li>

        <li>
          <button
            type="button"
            onClick={() => {
              setLanguagesDraft(settings.languages);
              setLanguagesOpen(true);
            }}
            className={ROW}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold text-[var(--personal-text)]">
                Languages I speak
              </span>
              <span className="text-[13px] text-[var(--personal-text-secondary)]">
                The voice reads unclear words as one of these
              </span>
            </span>
            <span className="max-w-[45%] truncate text-[15px] text-[var(--personal-text-secondary)]">
              {settings.languages}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-5 text-[var(--personal-text-tertiary)]"
            />
          </button>
        </li>
      </ul>

      <p className="mt-2 px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
        Calls run on Google Gemini Live. Google hears the call, including the replies it reads to
        you. Calls follow the languages you list above.
      </p>

      {voiceOpen ? (
        <VoiceSheet
          selected={settings.voiceName}
          onPick={(name) => patch({ voiceName: name })}
          onClose={() => setVoiceOpen(false)}
        />
      ) : null}

      {quietOpen ? (
        <Sheet open onOpenChange={(next) => (next ? undefined : setQuietOpen(false))}>
          <SheetPopup
            side="bottom"
            role="dialog"
            showCloseButton={false}
            forceBackdrop
            backdropClassName="bg-black/[0.55]"
            className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] w-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-5 pb-3 text-[var(--personal-text)]"
          >
            <SheetTitle className="px-1 text-center text-[17px] leading-6 font-bold">
              Hang up when quiet
            </SheetTitle>
            <div className="mt-3 flex flex-col gap-1">
              {VOICE_CALL_QUIET_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    patch({ quietHangupMinutes: minutes });
                    setQuietOpen(false);
                  }}
                  className={ROW}
                >
                  <span className="flex-1 text-[16px] font-semibold">After {minutes} min</span>
                  {settings.quietHangupMinutes === minutes ? (
                    <Check aria-hidden="true" className="size-5 text-[var(--personal-live)]" />
                  ) : null}
                </button>
              ))}
            </div>
          </SheetPopup>
        </Sheet>
      ) : null}
      {languagesOpen ? (
        <Sheet open onOpenChange={(next) => (next ? undefined : setLanguagesOpen(false))}>
          <SheetPopup
            side="bottom"
            role="dialog"
            showCloseButton={false}
            forceBackdrop
            backdropClassName="bg-black/[0.55]"
            className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] w-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-5 pb-3 text-[var(--personal-text)]"
          >
            <SheetTitle className="px-1 text-center text-[17px] leading-6 font-bold">
              Languages I speak
            </SheetTitle>
            <p className="mt-2 px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              A call hears you better when it knows what to expect. List every language you might
              speak on a call, separated by commas.
            </p>
            <input
              autoFocus
              value={languagesDraft}
              onChange={(event) => setLanguagesDraft(event.target.value)}
              maxLength={VOICE_CALL_LANGUAGES_MAX_CHARS}
              placeholder={VOICE_CALL_DEFAULT_LANGUAGES}
              aria-label="Languages I speak"
              dir="auto"
              className={`${FIELD} mt-3 font-sans`}
            />
            <div className="mt-3 flex gap-2 px-1">
              <button
                type="button"
                onClick={() => setLanguagesOpen(false)}
                className={`${ROW_BUTTON} flex-1 justify-center`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  // An emptied field is the default, never a blank line in the
                  // instruction: the server applies the same rule.
                  patch({
                    languages:
                      languagesDraft.trim() === "" ? VOICE_CALL_DEFAULT_LANGUAGES : languagesDraft,
                  });
                  setLanguagesOpen(false);
                }}
                className={`${ROW_BUTTON} flex-1 justify-center`}
              >
                Save
              </button>
            </div>
          </SheetPopup>
        </Sheet>
      ) : null}
    </>
  );
}

function VoiceSheet({
  selected,
  onPick,
  onClose,
}: {
  readonly selected: string;
  readonly onPick: (name: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [showMore, setShowMore] = useState(false);
  const row = (name: string, note: string | null) => (
    <div key={name} className={`${ROW} justify-between`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected === name}
        onClick={() => {
          onPick(name);
          onClose();
        }}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
      >
        <span className="truncate text-[16px] font-semibold text-[var(--personal-text)]">
          {name}
        </span>
        {note !== null ? (
          <span className="truncate text-[13px] text-[var(--personal-text-tertiary)]">{note}</span>
        ) : null}
        {selected === name ? (
          <Check aria-hidden="true" className="size-5 shrink-0 text-[var(--personal-live)]" />
        ) : null}
      </button>
    </div>
  );

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup
        side="bottom"
        role="dialog"
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-black/[0.55]"
        className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] max-h-[90dvh] w-auto overflow-y-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-5 pb-3 text-[var(--personal-text)]"
      >
        <SheetTitle className="px-1 text-center text-[17px] leading-6 font-bold">Voice</SheetTitle>
        <p className="mt-1 px-1 text-center text-[13px] text-[var(--personal-text-secondary)]">
          Tap a voice to use it on every call.
        </p>
        <div role="radiogroup" aria-label="Voice" className="mt-3 flex flex-col">
          {CURATED_VOICES.map((voice) => row(voice.name, voice.note))}
          {showMore ? MORE_VOICES.map((name) => row(name, null)) : null}
        </div>
        <button
          type="button"
          onClick={() => setShowMore((previous) => !previous)}
          className={`${ROW} mt-1 justify-center text-[15px] font-semibold text-[var(--personal-text-secondary)]`}
        >
          {showMore ? "Fewer voices" : `More voices · ${MORE_VOICES.length} more`}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-1 h-[50px] w-full rounded-[var(--personal-radius-button)] text-base font-medium text-[var(--personal-text)] outline-none"
        >
          Done
        </button>
      </SheetPopup>
    </Sheet>
  );
}
