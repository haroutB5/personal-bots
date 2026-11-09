import { describe, expect, it } from "vite-plus/test";

import { passwordFieldProps } from "./passwordField";

describe("passwordFieldProps", () => {
  it("keeps the hidden field a password with no autofill or suggestions", () => {
    expect(passwordFieldProps(false)).toMatchObject({
      secureTextEntry: true,
      keyboardType: "default",
      autoComplete: "off",
      autoCorrect: false,
      spellCheck: false,
      importantForAutofill: "no",
      textContentType: "none",
    });
  });

  it("reveals through the visible-password variation, never a text field", () => {
    expect(passwordFieldProps(true)).toMatchObject({
      secureTextEntry: false,
      keyboardType: "visible-password",
      autoComplete: "off",
      autoCorrect: false,
      spellCheck: false,
      importantForAutofill: "no",
      textContentType: "none",
    });
  });
});
