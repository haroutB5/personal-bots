import type { EnvironmentId } from "@t3tools/contracts";
import {
  closeBrowserConfirmMessage,
  formatActivityTime,
} from "@hbots/personal-client/computer/computerModel";
import type { ComputerSource } from "@hbots/personal-client/computer/computerContract";
import { mergeActivity } from "@hbots/personal-client/computer/computerActivity";
import {
  browserDriver,
  desktopDriver,
  driverLine,
} from "@hbots/personal-client/computer/computerDrivers";
import {
  helpKind,
  helpOrigin,
  readBrowserEvent,
  readDesktopEvent,
} from "@hbots/personal-client/computer/computerContract";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  loadSourcePrefs,
  resolveSource,
  saveSourcePrefs,
  type SourcePrefs,
} from "@hbots/personal-client/computer/computerSource";
import { IconDeviceLaptop, IconMaximize, IconRefresh, IconWorld } from "@tabler/icons-react-native";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecureScreen } from "../platform/secureScreen";
import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { ComputerActivitySheet } from "./ComputerActivitySheet";
import {
  ActivityCard,
  ComputerActions,
  DriverCard,
  HelpCard,
  SensitiveCard,
} from "./ComputerCards";
import { ComputerLiveView, type ComputerLiveViewHandle } from "./ComputerLiveView";
import {
  activeEgressPause,
  browserEvents,
  browserStage,
  browserToolbar,
  computerActions,
  computerDotTone,
  computerHeader,
  desktopQueue,
  desktopEvents,
  liveViewMode,
  pageAddressLabel,
  type BrowserStage,
} from "./computerScreenModel";
import type { LiveViewURLs } from "./liveViewAccess";

const NOW_TICK_MS = 5000;
const AUTO_TAP_GRACE_MS = 3000;

export function ComputerScreen({
  native,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  useSecureScreen(true);
  const environmentId = native.environmentId as EnvironmentId;
  const feed = native.computer.useComputerFeed(environmentId);
  const desktopStatus = native.computer.useDesktopStatus(environmentId);
  const desktopActivity = native.computer.useDesktopActivity(environmentId);
  const status = feed.feed.status;
  const reachable = environmentId !== null && feed.error === null;

  const takeBrowser = native.client.useAtomCommand(native.computer.personalBrowserTakeControl, {
    reportFailure: false,
  });
  const returnBrowser = native.client.useAtomCommand(native.computer.personalBrowserReturnToAgent, {
    reportFailure: false,
  });
  const closeBrowser = native.client.useAtomCommand(native.computer.personalBrowserClose, {
    reportFailure: false,
  });
  const approveEgress = native.client.useAtomCommand(native.computer.personalBrowserApproveEgress, {
    reportFailure: false,
  });
  const refuseEgress = native.client.useAtomCommand(native.computer.personalBrowserRefuseEgress, {
    reportFailure: false,
  });
  const stopDesktop = native.client.useAtomCommand(native.computer.personalDesktopStop, {
    reportFailure: false,
  });

  const [prefs, setPrefs] = useState<SourcePrefs>(() => loadSourcePrefs(native.client.ports.kv));
  const [shown, setShown] = useState<ComputerSource>(() => (prefs.auto ? "browser" : prefs.pinned));
  const [tapAt, setTapAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fullScreen, setFullScreen] = useState(false);
  const [takeSource, setTakeSource] = useState<ComputerSource | null>(null);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [egressBusy, setEgressBusy] = useState(false);
  const [egressError, setEgressError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [urls, setUrls] = useState<LiveViewURLs | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlEpoch, setUrlEpoch] = useState(0);
  const [pausedDriver, setPausedDriver] = useState<ReturnType<typeof browserDriver> | null>(null);
  const [address, setAddress] = useState("");
  const liveRef = useRef<ComputerLiveViewHandle>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    saveSourcePrefs(native.client.ports.kv, prefs);
  }, [native.client.ports.kv, prefs]);

  const refreshURLs = useCallback(() => {
    setUrlEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setUrlError(null);
    native
      .liveViews()
      .then((next) => {
        if (!cancelled) setUrls(next);
      })
      .catch(() => {
        if (!cancelled) {
          setUrls(null);
          setUrlError("Couldn't open the live view.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [native, urlEpoch]);

  const events = useMemo(
    () =>
      mergeActivity(feed.feed.events.map(readBrowserEvent), desktopActivity.map(readDesktopEvent)),
    [feed.feed.events, desktopActivity],
  );
  const lastAction = useMemo(() => {
    let best: { source: ComputerSource; at: number; botName: string | null } | null = null;
    for (const event of events) {
      if (["control", "release", "stop", "help"].includes(event.kind)) continue;
      if (/^you\b/i.test(event.summary)) continue;
      const at = Date.parse(event.at);
      if (best === null || at > best.at) {
        best = { source: event.source, at, botName: event.botName };
      }
    }
    return best;
  }, [events]);

  const controller = status?.controller;
  const youBrowser = controller?._tag === "Human" && controller.self;
  const otherDevice = controller?._tag === "Human" && !controller.self;
  const browserDriverNow = browserDriver(status, browserEvents(events), youBrowser);
  const desktopDriverNow = desktopDriver(desktopStatus, false);
  const help = status?.helpRequest ?? null;
  const pause = activeEgressPause(status);
  const helpOpen = help !== null || pause !== null;
  const desktopAvailable = desktopStatus?.available !== false;

  const resolved = resolveSource({
    prefs,
    current: shown,
    helpOpen,
    controlSource: youBrowser ? "browser" : takeSource,
    lastBotAction: lastAction,
    lastTapAt: tapAt,
    now,
    desktopAvailable,
  });
  useEffect(() => {
    if (resolved !== shown) setShown(resolved);
  }, [resolved, shown]);

  useEffect(() => {
    if (takeError === null) return;
    const timer = setTimeout(() => setTakeError(null), 10_000);
    return () => clearTimeout(timer);
  }, [takeError]);

  const shownDriver = shown === "desktop" ? desktopDriverNow : browserDriverNow;
  const otherSource: ComputerSource = shown === "browser" ? "desktop" : "browser";
  const otherDriver = shown === "browser" ? desktopDriverNow : browserDriverNow;
  const youShown = shown === "browser" ? youBrowser : takeSource === "desktop";
  const takingShown = takeSource === shown && !youShown;
  const queue = desktopQueue({
    browser: status,
    desktop: desktopStatus,
    paused: youShown ? pausedDriver : null,
  });
  const header = computerHeader({
    shown,
    reachable,
    loading: feed.loading,
    status,
    desktop: desktopStatus,
    browserDriver: browserDriverNow,
    desktopDriver: desktopDriverNow,
    youControl: youShown,
    otherDevice: shown === "browser" && otherDevice,
  });
  const dotTone = computerDotTone({
    reachable,
    status,
    loading: feed.loading,
  });
  const stage = browserStage({ status, reachable, loading: feed.loading });
  const toolbar = browserToolbar({
    status,
    ready: urls !== null,
    inControl: youBrowser,
    reachable,
  });
  const actions = computerActions({
    shown,
    reachable,
    status,
    desktop: desktopStatus,
    driver: shownDriver,
    youShown,
    taking: takingShown,
    helpOpen,
  });
  const isLive = liveViewMode({ status, reachable }) === "live";
  const liveActive = focused && appActive && !fullScreen;

  useEffect(() => {
    if (toolbar.address !== address) setAddress(toolbar.address);
  }, [toolbar.address, address]);

  const selectSource = (source: ComputerSource) => {
    setPrefs({ auto: false, pinned: source });
    setShown(source);
    setTapAt(Date.now());
  };
  const toggleAuto = () => {
    setPrefs((current) => ({ auto: !current.auto, pinned: shown }));
    setTapAt(Date.now());
    setTimeout(() => setNow(Date.now()), AUTO_TAP_GRACE_MS + 100);
  };

  const takeControl = async () => {
    setTakeError(null);
    setActionError(null);
    setPausedDriver(browserDriverNow.state === "using" ? browserDriverNow : null);
    setTakeSource("browser");
    setFullScreen(true);
    const result = await takeBrowser({ environmentId, input: {} });
    const failure = commandFailureMessage(result, "Could not take the browser.");
    if (failure !== null) {
      setTakeSource(null);
      setPausedDriver(null);
      setTakeError(failure);
      setFullScreen(false);
    }
  };

  const handBack = async () => {
    setTakeError(null);
    const result = await returnBrowser({ environmentId, input: {} });
    const failure = commandFailureMessage(result, "Could not hand the browser back.");
    if (failure !== null) {
      setTakeError(failure);
      return;
    }
    setTakeSource(null);
    setPausedDriver(null);
    setFullScreen(false);
  };

  const stop = async () => {
    if (stopBusy) return;
    setActionError(null);
    if (shown === "browser") {
      const message = closeBrowserConfirmMessage(status, controller?._tag === "Agent");
      const run = async () => {
        setStopBusy(true);
        try {
          const result = await closeBrowser({ environmentId, input: {} });
          const failure = commandFailureMessage(result, "Could not close the browser.");
          if (failure !== null) setActionError(failure);
        } finally {
          setStopBusy(false);
        }
      };
      if (message === null) {
        await run();
        return;
      }
      Alert.alert("Close browser", message, [
        { text: "Cancel", style: "cancel" },
        { text: "Close browser", style: "destructive", onPress: () => void run() },
      ]);
      return;
    }
    const who = desktopDriverNow.botName ?? "the bot";
    Alert.alert(
      "Stop the desktop",
      `Stop ${who} using the desktop?\nIts task is told you stopped it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: () => {
            setStopBusy(true);
            void stopDesktop({ environmentId, input: {} })
              .then((result) => {
                const failure = commandFailureMessage(result, "Could not stop the desktop.");
                if (failure !== null) setActionError(failure);
              })
              .finally(() => setStopBusy(false));
          },
        },
      ],
    );
  };

  const decideEgress = async (kind: "approve" | "refuse") => {
    if (pause === null || egressBusy) return;
    setEgressBusy(true);
    setEgressError(null);
    try {
      const command = kind === "approve" ? approveEgress : refuseEgress;
      const result = await command({ environmentId, input: { threadId: pause.threadId as never } });
      const failure = commandFailureMessage(
        result,
        kind === "approve" ? "Could not allow that step." : "Could not refuse that step.",
      );
      if (failure !== null) setEgressError(failure);
    } finally {
      setEgressBusy(false);
    }
  };

  const openChat = (botId: string | null, threadId: string | null) => {
    if (botId !== null && threadId !== null) onOpenChat(botId, threadId);
  };

  const sendReload = () => {
    liveRef.current?.sendInput({ _tag: "Reload" });
  };

  const submitAddress = () => {
    if (address.trim().length === 0) return;
    liveRef.current?.sendInput({ _tag: "Navigate", url: address.trim() });
  };

  const idleStage =
    shown === "browser" && stage.kind === "idle" && desktopDriverNow.state !== "using";
  const browserPlaceholder = !reachable
    ? "The laptop is offline. The browser keeps running there and reappears when it reconnects."
    : stage.kind === "idle"
      ? stage.message
      : null;

  const lastAgent = status?.lastAgent ?? null;
  const lastUsedName =
    lastAgent === null
      ? null
      : (events.find(
          (event) =>
            event.source === "browser" &&
            event.threadId === lastAgent.threadId &&
            event.botName !== null,
        )?.botName ?? lastAgent.botId);
  const lastUsedAt = status?.lastStop ?? null;
  const nothingOnScreen = !reachable || idleStage;

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title="Computer"
        subtitle={header.text}
        right={<View style={[styles.dot, { backgroundColor: toneColor(dotTone) }]} />}
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.sourceRow} accessibilityRole="tablist">
          {(["browser", "desktop"] as const).map((source) => {
            const selected = shown === source;
            const unavailable = source === "desktop" && !desktopAvailable;
            const Icon = source === "browser" ? IconWorld : IconDeviceLaptop;
            return (
              <Pressable
                key={source}
                accessibilityRole="tab"
                accessibilityState={{ selected, disabled: unavailable }}
                disabled={unavailable || !reachable}
                onPress={() => selectSource(source)}
                style={[styles.sourceTab, selected ? styles.sourceTabActive : null]}
              >
                <Icon size={18} color={selected ? tokens.text : tokens.textSecondary} />
                <Text style={[styles.sourceText, selected ? styles.sourceTextActive : null]}>
                  {source === "browser" ? "Browser" : "Desktop"}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: prefs.auto }}
            onPress={toggleAuto}
            style={[styles.autoButton, prefs.auto ? styles.autoButtonOn : null]}
          >
            <Text style={[styles.autoText, prefs.auto ? styles.autoTextOn : null]}>Auto</Text>
          </Pressable>
        </View>

        {pause !== null ? (
          <SensitiveCard
            botName={pause.botName}
            sources={pause.sources}
            destination={pause.destination}
            canDecide
            busy={egressBusy}
            error={egressError}
            onAllow={() => void decideEgress("approve")}
            onRefuse={() => void decideEgress("refuse")}
            onTakeControl={() => void takeControl()}
          />
        ) : help !== null ? (
          <HelpCard
            botName={help.botName}
            body={helpBody(helpKind(status), helpOrigin(status), help.botName, help.reason)}
            timeText={askedText(help.requestedAt, now)}
            onOpenChat={() => openChat(help.botId, help.threadId)}
          />
        ) : null}

        <View style={styles.stage}>
          {shown === "browser" ? (
            browserPlaceholder !== null ? (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>{browserPlaceholder}</Text>
                {stage.kind === "idle" && status !== null ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void takeControl()}
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryButtonText}>Take control</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : isLive ? (
              <ComputerLiveView
                ref={liveRef}
                mode="browser"
                url={urls?.browser ?? null}
                interactive={youBrowser}
                fullScreen={false}
                paused={!liveActive}
                attemptKey={urlEpoch}
                syncViewport={false}
                onNeedsURL={refreshURLs}
              />
            ) : (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>{placeholderFor(stage)}</Text>
              </View>
            )
          ) : desktopAvailable ? (
            <View>
              <ComputerLiveView
                mode="desktop"
                url={urls?.desktop ?? null}
                interactive={false}
                fullScreen={false}
                paused={!liveActive}
                attemptKey={urlEpoch}
                syncViewport={false}
                onNeedsURL={refreshURLs}
              />
              <View style={styles.desktopCaption}>
                <Text style={styles.desktopCaptionText}>
                  Watch only on the phone. Use the laptop to control it.
                </Text>
                {desktopStatus?.focusedWindow === null ||
                desktopStatus?.focusedWindow === undefined ? null : (
                  <Text style={styles.desktopCaptionText} numberOfLines={1}>
                    {desktopStatus.focusedWindow.title}
                  </Text>
                )}
              </View>
            </View>
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderText}>
                The live view needs the bots server on Windows or Omarchy.
              </Text>
            </View>
          )}
        </View>

        {shown === "browser" ? (
          <View style={styles.toolbar}>
            <View style={styles.addressBox}>
              <Text style={styles.lock}>{toolbar.secure ? "https" : "web"}</Text>
              {toolbar.editable ? (
                <TextInput
                  style={styles.addressInput}
                  value={address}
                  onChangeText={setAddress}
                  onSubmitEditing={submitAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  placeholder="Type a URL"
                  placeholderTextColor={tokens.textTertiary}
                />
              ) : (
                <Text style={styles.addressText} numberOfLines={1}>
                  {pageAddressLabel(status)}
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reload"
              disabled={!toolbar.canReload}
              onPress={sendReload}
              style={[styles.toolButton, !toolbar.canReload ? styles.disabled : null]}
            >
              <IconRefresh size={18} color={tokens.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open browser full screen"
              onPress={() => setFullScreen(true)}
              style={styles.toolButton}
            >
              <IconMaximize size={18} color={tokens.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Browser options"
              onPress={() => setOptionsOpen(true)}
              style={styles.toolButton}
            >
              <Text style={styles.moreText}>•••</Text>
            </Pressable>
          </View>
        ) : null}

        {nothingOnScreen ? (
          lastAgent === null ? null : (
            <DriverCard
              title={`Last used by ${lastUsedName ?? "a bot"}`}
              line={
                lastUsedAt === null
                  ? "Brave · closed"
                  : `Brave · closed at ${formatActivityTime(lastUsedAt)}`
              }
              state="idle"
              onOpenChat={() => openChat(lastAgent.botId, lastAgent.threadId)}
              style={styles.cardGap}
            />
          )
        ) : (
          <>
            <DriverCard
              title={driverTitle(shownDriver, shown === "desktop" ? "Desktop" : "Brave")}
              line={driverLine({
                driver: shownDriver,
                events: shown === "desktop" ? desktopEvents(events) : browserEvents(events),
                now,
              })}
              state={shownDriver.state}
              queue={queue}
              onOpenChat={
                shownDriver.threadId !== null && shownDriver.botId !== null
                  ? () => openChat(shownDriver.botId, shownDriver.threadId)
                  : undefined
              }
            />
            {otherDriver.state === "using" ? (
              <DriverCard
                title={otherDriver.botName ?? "A bot"}
                line={`${driverLine({
                  driver: otherDriver,
                  events: otherSource === "desktop" ? desktopEvents(events) : browserEvents(events),
                  now,
                })} · in the background`}
                state="using"
                onPress={() => selectSource(otherSource)}
              />
            ) : null}
            {shown === "browser" ? (
              <ComputerActions
                inControl={youBrowser}
                takeDisabled={actions.takeDisabled}
                handBackLabel={
                  queue.paused !== null && queue.paused.botName.length <= 14
                    ? `Hand back to ${queue.paused.botName}`
                    : "Hand back"
                }
                onTake={() => void takeControl()}
                onHandBack={() => void handBack()}
                stopLabel={actions.stopLabel}
                onStop={() => void stop()}
                busy={stopBusy}
              />
            ) : actions.stopLabel === null ? null : (
              <ComputerActions
                inControl={false}
                takeDisabled
                handBackLabel="Hand back"
                onTake={() => undefined}
                onHandBack={() => undefined}
                stopLabel={actions.stopLabel}
                onStop={() => void stop()}
                busy={stopBusy}
              />
            )}
          </>
        )}

        {takeError !== null || actionError !== null || urlError !== null ? (
          <Text style={styles.error} maxFontSizeMultiplier={1.4}>
            {takeError ?? actionError ?? urlError}
          </Text>
        ) : null}

        <ActivityCard events={events} limit={5} onSeeAll={() => setActivityOpen(true)} />
      </ScrollView>

      <Modal
        visible={fullScreen}
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setFullScreen(false)}
      >
        <View style={[styles.fullScreen, { paddingTop: insets.top }]}>
          <View style={styles.controlBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Exit full screen"
              onPress={() => setFullScreen(false)}
              style={styles.controlButton}
            >
              <Text style={styles.controlButtonText}>Exit</Text>
            </Pressable>
            <View style={styles.controlTitle}>
              <Text style={styles.controlTitleText} numberOfLines={1}>
                {youBrowser ? "You're in control" : "Taking control…"}
              </Text>
              {help === null ? null : (
                <Text style={styles.controlSubtitle} numberOfLines={1}>
                  {help.botName}: {help.reason}
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hand back"
              onPress={() => void handBack()}
              style={styles.handBack}
            >
              <Text style={styles.primaryButtonText}>Hand back</Text>
            </Pressable>
          </View>
          <ComputerLiveView
            mode="browser"
            url={urls?.browser ?? null}
            interactive={youBrowser}
            fullScreen
            paused={!appActive}
            attemptKey={urlEpoch}
            syncViewport={youBrowser}
            onNeedsURL={refreshURLs}
          />
        </View>
      </Modal>

      <ComputerActivitySheet
        native={native}
        open={activityOpen}
        events={events}
        onClose={() => setActivityOpen(false)}
      />

      <SheetShell
        visible={optionsOpen}
        title="Browser options"
        onClose={() => setOptionsOpen(false)}
      >
        <SheetAction
          label="Reload"
          detail="Reload the page"
          disabled={!toolbar.canReload}
          onPress={() => {
            sendReload();
            setOptionsOpen(false);
          }}
        />
        <SheetAction
          label="Page forward"
          detail="Go to the next page in history"
          disabled={!toolbar.canForward}
          onPress={() => {
            liveRef.current?.sendInput({ _tag: "Forward" });
            setOptionsOpen(false);
          }}
        />
        <SheetAction
          label="Close browser"
          detail="Tabs close and the bot is told the browser closed"
          danger
          disabled={!toolbar.canClose}
          onPress={() => {
            setOptionsOpen(false);
            void stop();
          }}
        />
      </SheetShell>
    </View>
  );

  function driverTitle(driver: ReturnType<typeof browserDriver>, fallback: string): string {
    if (driver.state === "using") return driver.botName ?? "A bot";
    if (driver.state === "idle") return `${driver.botName ?? "A bot"} left it open`;
    if (driver.state === "you") return "You";
    return fallback;
  }
}

function toneColor(tone: string): string {
  switch (tone) {
    case "live":
      return tokens.working;
    case "pending":
    case "review":
      return tokens.reviewText;
    case "problem":
      return tokens.danger;
    case "control":
      return tokens.primary;
    default:
      return tokens.textTertiary;
  }
}

function placeholderFor(stage: BrowserStage): string {
  switch (stage.kind) {
    case "offline":
    case "connecting":
    case "starting":
    case "locked":
    case "crashed":
    case "idle":
      return stage.message;
    case "live":
      return "";
  }
}

function askedText(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Asked just now";
  if (minutes < 60) return `Asked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Asked ${hours} h ago`;
}

function helpBody(
  kind: ReturnType<typeof helpKind>,
  origin: string | null,
  botName: string,
  reason: string,
): string {
  if (origin === null) return reason;
  switch (kind) {
    case "captcha":
      return `A human check is blocking ${origin}. Solve it, then hand back and ${botName} carries on.`;
    case "code":
      return `${origin} wants a sign-in code. Enter it yourself on the page, then hand back.`;
    case "login":
      return `${botName} needs you to sign in to ${origin}. Sign in on the page, then hand back.`;
    default:
      return reason;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  sourceRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  sourceTab: {
    flex: 1,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
  },
  sourceTabActive: {
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  sourceText: { color: tokens.textSecondary, fontSize: 14 },
  sourceTextActive: { color: tokens.text, fontWeight: "600" },
  autoButton: {
    height: 44,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  autoButtonOn: { borderColor: tokens.borderStrong, backgroundColor: tokens.surface },
  autoText: { color: tokens.textSecondary, fontSize: 14 },
  autoTextOn: { color: tokens.text, fontWeight: "600" },
  stage: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  placeholder: { alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
  placeholderText: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { color: tokens.primaryText, fontSize: 15, fontWeight: "700" },
  desktopCaption: { paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  desktopCaptionText: { color: tokens.textSecondary, fontSize: 12, lineHeight: 17 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8 },
  addressBox: {
    flex: 1,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 12,
  },
  lock: { color: tokens.textSecondary, fontSize: 11, fontWeight: "600" },
  addressText: { flex: 1, color: tokens.text, fontSize: 14 },
  addressInput: { flex: 1, color: tokens.text, fontSize: 15, padding: 0 },
  toolButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
  },
  moreText: { color: tokens.textSecondary, fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.4 },
  cardGap: { marginTop: 4 },
  error: { color: tokens.danger, fontSize: 13 },
  fullScreen: { flex: 1, backgroundColor: tokens.bg },
  controlBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    backgroundColor: tokens.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  controlButton: { minWidth: 52, height: 44, alignItems: "center", justifyContent: "center" },
  controlButtonText: { color: tokens.text, fontSize: 15 },
  controlTitle: { flex: 1, gap: 1 },
  controlTitleText: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  controlSubtitle: { color: tokens.reviewText, fontSize: 12 },
  handBack: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
