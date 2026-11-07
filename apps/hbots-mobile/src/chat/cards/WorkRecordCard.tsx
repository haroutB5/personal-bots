import type { PersonalTaskWorkRecord } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import { workRecordIsEmpty } from "./workRecordModel";

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={cardStyles.label}>{label}</Text>
      {children}
    </View>
  );
}

function List({ items }: { readonly items: ReadonlyArray<string> }) {
  return (
    <View style={{ marginTop: 2, gap: 4 }}>
      {items.map((text) => (
        <Text key={text} style={{ color: tokens.text, fontSize: 14, lineHeight: 20 }}>
          {text}
        </Text>
      ))}
    </View>
  );
}

/**
 * A task's work record: the short state that outlives its chat. Read only, and
 * folded away until the owner opens it.
 */
export function WorkRecordCard({
  record,
  defaultOpen = false,
}: {
  readonly record: PersonalTaskWorkRecord;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (workRecordIsEmpty(record)) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          {
            minHeight: 36,
            justifyContent: "center",
            borderRadius: 8,
          },
          pressed ? cardStyles.pressed : null,
        ]}
      >
        <Text style={{ color: tokens.text, fontSize: 14, fontWeight: "600" }}>
          {open ? "Hide work record" : "Work record"}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: 4 }}>
          <Text style={cardStyles.secondary}>
            What this task keeps apart from its chat. If it is reopened after a long chat, it starts
            from this.
          </Text>
          {record.nextStep.length > 0 ? (
            <Section label="Next step">
              <Text style={cardStyles.body}>{record.nextStep}</Text>
            </Section>
          ) : null}
          {record.outstanding.length > 0 ? (
            <Section label="Left to do">
              <List items={record.outstanding} />
            </Section>
          ) : null}
          {record.decisions.length > 0 ? (
            <Section label="Decisions">
              <List items={record.decisions} />
            </Section>
          ) : null}
          {record.evidence.length > 0 ? (
            <Section label="Evidence">
              <View style={{ marginTop: 2, gap: 4 }}>
                {record.evidence.map((item) => (
                  <Text key={item.ref} style={{ color: tokens.text, fontSize: 14, lineHeight: 20 }}>
                    <Text style={{ color: tokens.textSecondary }}>{item.label}: </Text>
                    {item.ref}
                  </Text>
                ))}
              </View>
            </Section>
          ) : null}
          {record.lastResult.length > 0 ? (
            <Section
              label={`Last result${record.lastStatus === null ? "" : ` (${record.lastStatus})`}`}
            >
              <Text style={cardStyles.body}>{record.lastResult}</Text>
            </Section>
          ) : null}
          {record.updates.length > 0 ? (
            <Section label="Updates it was sent">
              <List items={record.updates.map((update) => update.text)} />
            </Section>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
