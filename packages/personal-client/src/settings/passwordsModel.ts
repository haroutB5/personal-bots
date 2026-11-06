import type { PersonalLogin } from "@t3tools/contracts";

export interface PasswordDraft {
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
}

export const emptyPasswordDraft = (): PasswordDraft => ({
  label: "",
  origin: "",
  username: "",
  password: "",
});

/** Existing passwords are deliberately not represented in client state. */
export const passwordDraftFromLogin = (login: PersonalLogin): PasswordDraft => ({
  label: login.label,
  origin: login.origin,
  username: login.username,
  password: "",
});

export interface PasswordDraftErrors {
  readonly label?: string;
  readonly origin?: string;
  readonly password?: string;
}

export const validatePasswordDraft = (draft: PasswordDraft): PasswordDraftErrors => {
  const errors: { label?: string; origin?: string; password?: string } = {};
  if (draft.label.trim().length === 0) errors.label = "Give this login a label.";
  const origin = draft.origin.trim();
  try {
    const parsed = new URL(origin);
    // Mirrors normalizePersonalLoginOrigin on the server, trailing-dot host included.
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.endsWith(".") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== origin
    ) {
      errors.origin = "Enter an exact HTTPS origin, such as https://example.com.";
    }
  } catch {
    errors.origin = "Enter an exact HTTPS origin, such as https://example.com.";
  }
  if (draft.password.length === 0) errors.password = "Re-enter the password to save.";
  return errors;
};
