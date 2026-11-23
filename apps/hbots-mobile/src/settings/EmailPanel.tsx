import { StyleSheet, Text, View } from "react-native";

import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import {
  accountStateLabel,
  canUseAccounts,
  EMAIL_DRAFTS_NOTE,
  HOW_TO_ADD_STEPS,
  type EmailAccountRow,
  type EmailView,
} from "./emailScreenModel";
import { Notice, PrimaryButton, Row, Section, SectionNote, TextButton } from "./SettingsUi";

export interface EmailPanelProps {
  readonly view: EmailView;
  readonly thunderbirdLine: string;
  readonly profileSize: string | null;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly error: string | null;
  readonly onUseAccounts: () => void;
  readonly onStartThunderbird: () => void;
  readonly onOpenHowTo: () => void;
}

const initialOf = (row: EmailAccountRow) => (row.vendor === "gmail" ? "G" : "O");

export function HowToSheet({
  visible,
  onClose,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  return (
    <SheetShell visible={visible} title="How to add an account" onClose={onClose} inline>
      <View style={styles.steps}>
        {HOW_TO_ADD_STEPS.map((step, index) => (
          <View key={step} style={styles.step}>
            <Text style={styles.stepNumber}>{index + 1}</Text>
            <Text style={styles.stepText} maxFontSizeMultiplier={1.4}>
              {step}
            </Text>
          </View>
        ))}
      </View>
    </SheetShell>
  );
}

export function EmailPanel(props: EmailPanelProps) {
  const { view } = props;
  return (
    <>
      <Section label="Mail app">
        <Row
          title="Thunderbird on the laptop"
          value={props.thunderbirdLine}
          last={props.profileSize === null}
        />
        {props.profileSize === null ? null : (
          <Row title="Mail kept on the laptop" value={props.profileSize} last />
        )}
      </Section>
      {props.error === null ? null : <Notice tone="danger">{props.error}</Notice>}
      {props.notice === null ? null : <Notice tone="success">{props.notice}</Notice>}

      {view.kind === "loading" ? <Notice>Checking Thunderbird…</Notice> : null}
      {view.kind === "unreachable" ? <Notice tone="danger">{view.message}</Notice> : null}

      {view.kind === "closed" ? (
        <View style={styles.block}>
          <Text style={styles.line} maxFontSizeMultiplier={1.4}>
            Thunderbird is closed on the laptop. Bots cannot read mail until it is open.
          </Text>
          <PrimaryButton
            label="Start Thunderbird"
            onPress={props.onStartThunderbird}
            busy={props.busy}
          />
        </View>
      ) : null}

      {view.kind === "repair" ? (
        <View style={styles.block}>
          <Text style={styles.line} maxFontSizeMultiplier={1.4}>
            {view.line}
          </Text>
          <Text style={styles.hint} maxFontSizeMultiplier={1.4}>
            Ask a bot to repair email.
          </Text>
        </View>
      ) : null}

      {view.kind === "no-accounts" ? (
        <View style={styles.block}>
          <Text style={styles.line} maxFontSizeMultiplier={1.4}>
            No mail accounts are set up in Thunderbird yet.
          </Text>
          <TextButton label="How to add an account" onPress={props.onOpenHowTo} />
        </View>
      ) : null}

      {view.kind === "accounts" ? (
        <>
          <Section label="Accounts">
            {view.rows.map((row, index) => (
              <Row
                key={row.accountId}
                title={row.address}
                hint={
                  row.state === "not-imap" ? "Tap to see how to add it again as IMAP" : undefined
                }
                value={accountStateLabel[row.state]}
                badge={initialOf(row)}
                onPress={row.state === "not-imap" ? props.onOpenHowTo : undefined}
                last={index === view.rows.length - 1}
              />
            ))}
          </Section>
          {canUseAccounts(view) ? (
            <PrimaryButton
              label="Use these accounts"
              onPress={props.onUseAccounts}
              busy={props.busy}
            />
          ) : null}
        </>
      ) : null}

      {view.kind === "accounts" ? (
        <TextButton label="How to add an account" onPress={props.onOpenHowTo} />
      ) : null}
      <SectionNote>{EMAIL_DRAFTS_NOTE}</SectionNote>
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10, marginTop: 12 },
  line: { color: tokens.text, fontSize: 15, lineHeight: 21 },
  hint: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
  steps: { gap: 14, paddingVertical: 8 },
  step: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    textAlign: "center",
    lineHeight: 24,
    color: tokens.primaryText,
    backgroundColor: tokens.primary,
    fontSize: 13,
    fontWeight: "600",
    overflow: "hidden",
  },
  stepText: { flex: 1, color: tokens.text, fontSize: 15, lineHeight: 21 },
});
