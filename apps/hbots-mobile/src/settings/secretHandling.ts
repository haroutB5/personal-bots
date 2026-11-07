import type {
  PersonalLoginId,
  PersonalSecretMode,
  PersonalSecretPlacement,
} from "@t3tools/contracts";
import type { PasswordDraft } from "@hbots/personal-client/settings/passwordsModel";
import {
  secretAccessChoice,
  type SecretAccessState,
} from "@hbots/personal-client/settings/secretAccess";
import * as Redacted from "effect/Redacted";

/** A credential draft survives only while the app is in front. */
export function draftAfterAppState(state: string, value: string): string {
  return state === "active" ? value : "";
}

export interface LoginInput {
  readonly loginId: PersonalLoginId;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}

/** The exact login payload: the password is wrapped before it leaves the screen. */
export function buildLoginInput(
  loginId: PersonalLoginId,
  draft: PasswordDraft,
  password: string,
): LoginInput {
  return {
    loginId,
    label: draft.label.trim(),
    origin: draft.origin.trim(),
    username: draft.username,
    password: Redacted.make(password),
  };
}

export interface ApiKeyInput {
  readonly name: string;
  readonly label: string;
  readonly value: Redacted.Redacted<string>;
  readonly shared: true;
  readonly mode: PersonalSecretMode;
  readonly origins: ReadonlyArray<string>;
  readonly placement: PersonalSecretPlacement;
}

/** The exact API key payload: value redacted, access choice flattened. */
export function buildApiKeyInput(
  name: string,
  label: string,
  value: string,
  access: SecretAccessState,
): ApiKeyInput {
  const choice = secretAccessChoice(access);
  return {
    name,
    label: label.trim(),
    value: Redacted.make(value),
    shared: true,
    mode: choice.mode,
    origins: choice.origins,
    placement: choice.placement,
  };
}
