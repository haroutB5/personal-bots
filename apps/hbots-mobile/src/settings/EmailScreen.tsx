import type { EnvironmentId } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { useEffect, useState } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { EmailPanel, HowToSheet } from "./EmailPanel";
import { emailView, profileSizeLabel, thunderbirdLine } from "./emailScreenModel";
import { SettingsPage } from "./SettingsUi";

const START_POLL_MS = 3_000;
const START_POLL_LIMIT = 20;

export function EmailScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const status = native.connections.usePersonalEmailStatus(environmentId);
  const connections = native.connections.usePersonalConnections(environmentId);
  const runUse = native.client.useAtomCommand(native.connections.personalEmailUseAccounts, {
    reportFailure: false,
  });
  const runStart = native.client.useAtomCommand(native.connections.personalEmailStartThunderbird, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const failure = status.error ?? connections.error;
  const view = emailView(status.data, connections.data?.connections ?? null, failure);
  const settled = view.kind !== "closed" && view.kind !== "loading";
  const refreshStatus = status.refresh;

  useEffect(() => {
    if (!waiting || settled) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      refreshStatus();
      if (ticks >= START_POLL_LIMIT) setWaiting(false);
    }, START_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, settled, refreshStatus]);

  const useAccounts = async () => {
    if (view.kind !== "accounts") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await runUse({ environmentId, input: { accountIds: view.useIds } });
    setBusy(false);
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Those accounts could not be saved.");
    if (failure !== null) {
      setError(failure);
      return;
    }
    if (result !== null && result._tag === "Success" && result.value.problem !== null) {
      setError(result.value.problem);
      return;
    }
    setNotice(
      result !== null && result._tag === "Success" && result.value.changed
        ? "Saved. Thunderbird is restarting on the laptop."
        : "Saved. Nothing needed to change.",
    );
    setWaiting(true);
  };

  const startThunderbird = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await runStart({ environmentId, input: {} });
    setBusy(false);
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Thunderbird could not be started.");
    if (failure !== null) {
      setError(failure);
      return;
    }
    if (result !== null && result._tag === "Success" && result.value.problem !== null) {
      setError(result.value.problem);
      return;
    }
    setWaiting(true);
  };

  return (
    <SettingsPage
      title="Email"
      onBack={onBack}
      sheet={<HowToSheet visible={howToOpen} onClose={() => setHowToOpen(false)} />}
    >
      <EmailPanel
        view={view}
        thunderbirdLine={thunderbirdLine(status.data, failure)}
        profileSize={profileSizeLabel(status.data?.profileSizeBytes ?? null)}
        busy={busy}
        notice={notice}
        error={error}
        onUseAccounts={() => void useAccounts()}
        onStartThunderbird={() => void startThunderbird()}
        onOpenHowTo={() => setHowToOpen(true)}
      />
    </SettingsPage>
  );
}
