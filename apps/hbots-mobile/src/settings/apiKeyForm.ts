import {
  secretAccessProblem,
  type SecretAccessState,
} from "@hbots/personal-client/settings/secretAccess";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type ApiKeyFormField = "name" | "value" | "access";

export interface ApiKeyFormProblem {
  readonly field: ApiKeyFormField;
  readonly message: string;
}

/**
 * The first field that blocks Save, so the form can put the message under that
 * field and focus it instead of showing a banner at the top of the page.
 */
export function apiKeyFormProblem(input: {
  readonly name: string;
  readonly value: string;
  readonly access: SecretAccessState;
}): ApiKeyFormProblem | null {
  if (input.name.trim().length === 0) {
    return { field: "name", message: "Give the key a name." };
  }
  if (!NAME_PATTERN.test(input.name)) {
    return {
      field: "name",
      message: "Use capitals, digits and underscores, starting with a letter: OPENWEATHER_API_KEY.",
    };
  }
  if (input.value.trim().length === 0) {
    return { field: "value", message: "Paste the key's value." };
  }
  const access = secretAccessProblem(input.access);
  return access === null ? null : { field: "access", message: access };
}
