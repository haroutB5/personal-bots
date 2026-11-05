import { StyleSheet } from "react-native";

import { tokens } from "../../shell/tokens";

export const cardStyles = StyleSheet.create({
  card: {
    marginVertical: 4,
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    padding: 14,
  },
  settled: {
    marginVertical: 4,
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 14,
  },
  headline: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 21,
  },
  body: {
    marginTop: 6,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  secondary: {
    marginTop: 6,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  label: {
    color: tokens.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  error: {
    marginTop: 8,
    color: tokens.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  button: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimary: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  buttonQuiet: {
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  buttonText: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
  },
  buttonPrimaryText: {
    color: tokens.primaryText,
  },
  buttonQuietText: {
    color: tokens.textSecondary,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },
  textBox: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  textBoxText: {
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
});
