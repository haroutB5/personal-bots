/**
 * Revealed is Android's VISIBLE_PASSWORD variation: shown, never suggested, autofilled or learnt.
 * The hidden field keeps the long-press menu for Paste; Android drops Copy and Cut when masked.
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
    contextMenuHidden: visible,
  };
}
