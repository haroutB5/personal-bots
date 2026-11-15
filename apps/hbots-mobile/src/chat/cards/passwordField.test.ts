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

  it("keeps the system menu on the hidden field so a long press can paste", () => {
    expect(passwordFieldProps(false).contextMenuHidden).toBe(false);
  });

  it("hides the system menu on the revealed field so the shown value cannot be copied", () => {
    expect(passwordFieldProps(true).contextMenuHidden).toBe(true);
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
