/**
 * Props for a password field in either display mode. Revealed is Android's
 * VISIBLE_PASSWORD variation: the keyboard may show the text but must not
 * suggest from it, autofill it or learn it. A plain text field would do all
 * three.
 */
export function passwordFieldProps(visible: boolean) {
  return {
    secureTextEntry: !visible,
    keyboardType: visible ? ("visible-password" as const) : ("default" as const),
    autoComplete: "off" as const,
    autoCorrect: false,
    spellCheck: false,
    importantForAutofill: "no" as const,
    textContentType: "none" as const,
    contextMenuHidden: true,
  };
}
