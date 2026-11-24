import type { EnvironmentId, PersonalBot } from "@t3tools/contracts";
import { closeBrowserConfirmMessage } from "@hbots/personal-client/computer/computerModel";
import type { ComputerSource } from "@hbots/personal-client/computer/computerContract";
import { latestBotAction, mergeActivity } from "@hbots/personal-client/computer/computerActivity";
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
  followedToast,
  loadSourcePrefs,
  resolveSource,
  saveSourcePrefs,
  type SourcePrefs,
} from "@hbots/personal-client/computer/computerSource";
import {
  IconAlertTriangle,
  IconDeviceLaptop,
  IconDots,
  IconFocus2,
  IconLock,
  IconMaximize,
  IconRefresh,
  IconWifiOff,
  IconWorld,
} from "../ui/icons";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { ComputerActivitySheet } from "./ComputerActivitySheet";
import {
  ActivityCard,
  ComputerActions,
  DriverCard,
  HelpCard,
  PageDialogCard,
  QueueCard,
  SensitiveCard,
  type DriverBotAvatar,
} from "./ComputerCards";
import { ComputerLiveView, type ComputerLiveViewHandle } from "./ComputerLiveView";
import { MachineStatsCard } from "./MachineStatsCard";
import { fullScreenVisible, inlinePaused, pipEnabled } from "./pipModel";
import type { FrameSize } from "./pipModel";
import { useInPip, usePipRequest } from "./usePictureInPicture";
import {
  activeEgressPause,
  browserEvents,
  browserStage,
  browserToolbar,
  computerActions,
  computerDotTone,
  computerHeader,
  computerScreenSecure,
  desktopEvents,
  desktopQueue,
  fullScreenHeader,
  headerPillLabel,
  isTicketFresh,
  liveViewMode,
  needsClockTick,
  needsLiveViewTicket,
  pageAddressLabel,
  showBrowserToolbar,
  takeControlView,
  takeProgress,
  takeStep,
  type BrowserStage,
  type TakeState,
} from "./computerScreenModel";
import type { LiveViewURLs } from "./liveViewAccess";

const NOW_TICK_MS = 5000;
const AUTO_TAP_GRACE_MS = 3000;
const FOLLOW_TOAST_MS = 2400;

interface StreamAccess {
  readonly urls: LiveViewURLs;
  readonly epoch: number;
  readonly fetchedAt: number;
}

export function ComputerScreen({
  native,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const environmentId = native.environmentId as EnvironmentId;
  const feed = native.computer.useComputerFeed(environmentId);
  const desktopStatus = native.computer.useDesktopStatus(environmentId);
  const desktopActivity = native.computer.useDesktopActivity(environmentId);
  const botsList = native.bots.usePersonalBotsList(environmentId);
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
  const [fullScreenSource, setFullScreenSource] = useState<ComputerSource | null>(null);
  const [take, setTake] = useState<TakeState>({ kind: "idle" });
  const [takeError, setTakeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [egressBusy, setEgressBusy] = useState(false);
  const [egressError, setEgressError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [streamAccess, setStreamAccess] = useState<StreamAccess | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [ticketRefreshNonce, setTicketRefreshNonce] = useState(0);
  const [pausedDriver, setPausedDriver] = useState<ReturnType<typeof browserDriver> | null>(null);
  const [address, setAddress] = useState("");
  const [followNotice, setFollowNotice] = useState<string | null>(null);
  const liveRef = useRef<ComputerLiveViewHandle>(null);
  const fullScreenLiveRef = useRef<ComputerLiveViewHandle>(null);
  const autoGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadBrowserControlRef = useRef(false);
  const ticketReqIdRef = useRef(0);
  const ticketInFlightIdRef = useRef<number | null>(null);
  const handledRefreshNonceRef = useRef(0);
  // Live views with their hidden field open for a password (inline and full screen can both mount).
  const [passwordFields, setPasswordFields] = useState(0);
  const passwordField = useCallback(
    (open: boolean) => setPasswordFields((count) => Math.max(0, count + (open ? 1 : -1))),
    [],
  );
  const [appActive, setAppActive] = useState(AppState.currentState === "active");

  const botAvatars = useMemo(() => {
    const map = new Map<string, DriverBotAvatar>();
    const items: ReadonlyArray<PersonalBot> = botsList.data?.bots ?? [];
    for (const bot of items) {
      map.set(bot.botId, { shape: bot.avatarShape, color: bot.avatarColor });
    }
    return map;
  }, [botsList.data]);

  const avatarFor = (botId: string | null): DriverBotAvatar | undefined =>
    botId === null ? undefined : botAvatars.get(botId);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return () => {
      if (autoGraceTimerRef.current !== null) clearTimeout(autoGraceTimerRef.current);
      if (followToastTimerRef.current !== null) clearTimeout(followToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    saveSourcePrefs(native.client.ports.kv, prefs);
  }, [native.client.ports.kv, prefs]);

  const refreshURLs = useCallback(() => {
    setTicketRefreshNonce((nonce) => nonce + 1);
  }, []);

  const events = useMemo(
    () =>
      mergeActivity(feed.feed.events.map(readBrowserEvent), desktopActivity.map(readDesktopEvent)),
    [feed.feed.events, desktopActivity],
  );
  const browserEventList = useMemo(() => browserEvents(events), [events]);
  const desktopEventList = useMemo(() => desktopEvents(events), [events]);

  const lastAction = useMemo(() => latestBotAction(events), [events]);

  const controller = status?.controller;
  const youBrowser = controller?._tag === "Human" && controller.self;
  const otherDevice = controller?._tag === "Human" && !controller.self;
  const browserDriverNow = useMemo(
    () => browserDriver(status, browserEventList, youBrowser),
    [status, browserEventList, youBrowser],
  );
  const desktopDriverNow = useMemo(() => desktopDriver(desktopStatus, false), [desktopStatus]);
  const help = status?.helpRequest ?? null;
  const dialog = status?.dialog ?? null;
  const pause = activeEgressPause(status);
  const helpOpen = help !== null || pause !== null;
  useSecureScreen(
    computerScreenSecure({
      focused,
      passwordFieldOpen: passwordFields > 0,
      sensitivePauseShown: pause !== null,
    }),
  );
  const desktopAvailable = desktopStatus?.available !== false;

  // Reset settled take state if the server externally revokes human control (timeout or other device).
  useEffect(() => {
    if (youBrowser) {
      hadBrowserControlRef.current = true;
      return;
    }
    if (hadBrowserControlRef.current) {
      hadBrowserControlRef.current = false;
      setTake((current) => takeStep(current, { kind: "externalRelease" }));
      setPausedDriver(null);
    }
  }, [youBrowser]);

  const progress = takeProgress({ take, shown, youBrowser });
  const resolved = resolveSource({
    prefs,
    current: shown,
    helpOpen,
    controlSource: progress.controlSource,
    lastBotAction: lastAction,
    lastTapAt: tapAt,
    now,
    desktopAvailable,
  });

  useEffect(() => {
    if (resolved === shown) return;
    if (prefs.auto) {
      const toast = followedToast(shown, resolved, lastAction?.botName ?? null);
      if (toast !== null) {
        // eslint-disable-next-line react/set-state-in-effect -- surface auto-switch toast when resolved source moves
        setFollowNotice(toast);
        if (followToastTimerRef.current !== null) clearTimeout(followToastTimerRef.current);
        followToastTimerRef.current = setTimeout(() => {
          followToastTimerRef.current = null;
          setFollowNotice(null);
        }, FOLLOW_TOAST_MS);
      }
    }
    setShown(resolved);
  }, [resolved, shown, prefs.auto, lastAction?.botName]);

  const clockNeeded = needsClockTick({
    focused,
    appActive,
    helpOpen,
    browserDriver: browserDriverNow,
    desktopDriver: desktopDriverNow,
    tapAt,
    now,
  });

  useEffect(() => {
    if (!clockNeeded) return;
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [clockNeeded]);

  useEffect(() => {
    if (takeError === null) return;
    const timer = setTimeout(() => setTakeError(null), 10_000);
    return () => clearTimeout(timer);
  }, [takeError]);

  const shownDriver = shown === "desktop" ? desktopDriverNow : browserDriverNow;
  const otherSource: ComputerSource = shown === "browser" ? "desktop" : "browser";
  const otherDriver = shown === "browser" ? desktopDriverNow : browserDriverNow;
  const { youShown, taking: takingShown } = progress;
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
  const urls = streamAccess?.urls ?? null;
  const urlEpoch = streamAccess?.epoch ?? 0;
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
  const control = takeControlView({ stage, takeError, urlError });
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const handleFrameSize = useCallback((next: FrameSize) => {
    setFrameSize((prev) =>
      prev !== null && prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }, []);
  const isFullScreen = fullScreenSource !== null;
  const streaming = isFullScreen
    ? fullScreenSource === "desktop"
      ? desktopAvailable
      : control.kind === "live"
    : shown === "browser"
      ? reachable && stage.kind !== "idle" && isLive
      : desktopAvailable;
  const inPip = useInPip();
  usePipRequest(pipEnabled({ streaming, focused, appActive, inPip }), frameSize);
  const liveActive = !inlinePaused({ focused, appActive, fullScreen: isFullScreen, inPip });

  // Lazy, expiry-aware WebSocket ticket minting with atomic { urls, epoch } updates.
  const needTicket = needsLiveViewTicket({
    reachable,
    focused,
    appActive,
    inPip,
    fullScreen: isFullScreen,
    shown,
    isLive,
    desktopAvailable,
  });

  useEffect(() => {
    if (!needTicket) return;
    const explicitRefresh = ticketRefreshNonce !== handledRefreshNonceRef.current;
    const fresh = isTicketFresh(streamAccess?.fetchedAt ?? null, Date.now());
    if (!explicitRefresh && fresh) return;
    if (ticketInFlightIdRef.current !== null && !explicitRefresh) return;

    handledRefreshNonceRef.current = ticketRefreshNonce;
    const reqId = ++ticketReqIdRef.current;
    ticketInFlightIdRef.current = reqId;
    let cancelled = false;
    setUrlError(null);
    native
      .liveViews()
      .then((next) => {
        if (cancelled || ticketReqIdRef.current !== reqId) return;
        setStreamAccess((prev) => ({
          urls: next,
          epoch: (prev?.epoch ?? 0) + 1,
          fetchedAt: Date.now(),
        }));
      })
      .catch(() => {
        if (cancelled || ticketReqIdRef.current !== reqId) return;
        setUrlError("Couldn't open the live view.");
      })
      .finally(() => {
        if (ticketInFlightIdRef.current === reqId) {
          ticketInFlightIdRef.current = null;
        }
      });
    return () => {
      cancelled = true;
      if (ticketInFlightIdRef.current === reqId) {
        ticketInFlightIdRef.current = null;
      }
    };
  }, [native, needTicket, ticketRefreshNonce, streamAccess?.fetchedAt]);

  const openFullScreen = (source: ComputerSource) => {
    if (!isTicketFresh(streamAccess?.fetchedAt ?? null, Date.now())) {
      refreshURLs();
    }
    setFullScreenSource(source);
  };

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- the toolbar address follows the embedded view
    setAddress(toolbar.address);
  }, [toolbar.address]);

  const activeLiveHandle = () => (isFullScreen ? fullScreenLiveRef.current : liveRef.current);

  const selectSource = (source: ComputerSource) => {
    setPrefs({ auto: false, pinned: source });
    setShown(source);
    // eslint-disable-next-line react/purity -- the tap time is captured by the handler, not render
    setTapAt(Date.now());
  };

  const toggleAuto = () => {
    setPrefs((current) => ({ auto: !current.auto, pinned: shown }));
    setTapAt(Date.now());
    if (autoGraceTimerRef.current !== null) clearTimeout(autoGraceTimerRef.current);
    autoGraceTimerRef.current = setTimeout(() => {
      autoGraceTimerRef.current = null;
      setNow(Date.now());
    }, AUTO_TAP_GRACE_MS + 100);
  };

  const takeControl = async () => {
    setTakeError(null);
    setActionError(null);
    setShown("browser");
    setPausedDriver(browserDriverNow.state === "using" ? browserDriverNow : null);
    setTake((current) => takeStep(current, { kind: "requested", source: "browser" }));
    openFullScreen("browser");
    const result = await takeBrowser({ environmentId, input: {} });
    const failure = commandFailureMessage(result, "Could not take the browser.");
    if (failure !== null) {
      setTake((current) => takeStep(current, { kind: "failed" }));
      setPausedDriver(null);
      setTakeError(failure);
      return;
    }
    setTake((current) => takeStep(current, { kind: "succeeded" }));
  };

  const handBack = async () => {
    setTakeError(null);
    const result = await returnBrowser({ environmentId, input: {} });
    const failure = commandFailureMessage(result, "Could not hand the browser back.");
    if (failure !== null) {
      setTakeError(failure);
      return;
    }
    hadBrowserControlRef.current = false;
    setTake((current) => takeStep(current, { kind: "handedBack" }));
    setPausedDriver(null);
    setFullScreenSource(null);
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
          else setFullScreenSource((current) => (current === "browser" ? null : current));
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

  const retryControl = () => {
    if (control.kind === "error" && control.retry === "url") {
      refreshURLs();
      return;
    }
    void takeControl();
  };

  const sendReload = () => {
    activeLiveHandle()?.sendInput({ _tag: "Reload" });
  };

  const submitAddress = () => {
    if (address.trim().length === 0) return;
    activeLiveHandle()?.sendInput({ _tag: "Navigate", url: address.trim() });
  };

  const answerDialog = (accept: boolean, promptText?: string) => {
    activeLiveHandle()?.sendInput({
      _tag: "AnswerDialog",
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  };

  const idleStage =
    shown === "browser" && stage.kind === "idle" && desktopDriverNow.state !== "using";
  const nothingOnScreen = !reachable || idleStage;
  const promptOwnsTake =
    shown === "browser" && !youBrowser && (pause !== null || help !== null || dialog !== null);
  const showDriverCard =
    !nothingOnScreen &&
    !youShown &&
    !promptOwnsTake &&
    (shownDriver.state === "using" || shownDriver.state === "idle");

  const modalSource: ComputerSource = fullScreenSource ?? "browser";
  const modalHeader = fullScreenHeader({
    source: modalSource,
    youBrowser,
    taking: take.kind === "pending" && take.source === "browser" && !youBrowser,
    control,
    browserDriver: browserDriverNow,
    desktopDriver: desktopDriverNow,
  });
  const statusPillLabel = headerPillLabel({
    reachable,
    headerTone: header.tone,
    dotTone,
  });
  const statusPillColor = toneColor(
    !reachable ? "idle" : header.tone !== "idle" ? header.tone : dotTone,
  );
  const browserToolbarVisible = shown === "browser" && showBrowserToolbar(stage);
  const pipSource: ComputerSource = fullScreenSource ?? shown;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            Computer
          </Text>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot, { backgroundColor: statusPillColor }]} />
            <Text style={styles.statusPillText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
              {statusPillLabel}
            </Text>
          </View>
        </View>
        <Text style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {header.text}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.sourceBar}>
          <View style={styles.segmentTrack} accessibilityRole="tablist">
            {(["browser", "desktop"] as const).map((source) => {
              const selected = shown === source;
              const unavailable = source === "desktop" && !desktopAvailable;
              const Icon = source === "browser" ? IconWorld : IconDeviceLaptop;
              const sourceDriver = source === "browser" ? browserDriverNow : desktopDriverNow;
              const sourceBot =
                sourceDriver.state === "using" ? avatarFor(sourceDriver.botId) : undefined;
              return (
                <Pressable
                  key={source}
                  accessibilityRole="tab"
                  accessibilityState={{ selected, disabled: unavailable }}
                  disabled={unavailable || !reachable}
                  onPress={() => selectSource(source)}
                  style={[
                    styles.segmentTab,
                    selected ? styles.segmentTabActive : null,
                    unavailable || !reachable ? styles.disabled : null,
                  ]}
                >
                  {sourceBot !== undefined ? (
                    <BotAvatar shape={sourceBot.shape} color={sourceBot.color} size={17} label="" />
                  ) : (
                    <Icon size={16} color={selected ? tokens.text : tokens.textSecondary} />
                  )}
                  <Text style={[styles.segmentText, selected ? styles.segmentTextActive : null]}>
                    {source === "browser" ? "Browser" : "Desktop"}
                  </Text>
                  {sourceDriver.state === "using" && sourceBot === undefined ? (
                    <View style={styles.segmentLiveDot} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: prefs.auto }}
            onPress={toggleAuto}
            style={[styles.autoButton, prefs.auto ? styles.autoButtonOn : null]}
          >
            <View style={[styles.autoDot, prefs.auto ? styles.autoDotOn : null]} />
            <Text style={[styles.autoText, prefs.auto ? styles.autoTextOn : null]}>Auto</Text>
          </Pressable>
        </View>

        {followNotice !== null ? (
          <View style={styles.followToast}>
            <Text style={styles.followToastText} numberOfLines={1}>
              {followNotice}
            </Text>
          </View>
        ) : null}

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
            takeDisabled={actions.takeDisabled}
            onTakeControl={() => void takeControl()}
            onOpenChat={() => openChat(help.botId, help.threadId)}
          />
        ) : null}

        {dialog !== null && shown === "browser" ? (
          <PageDialogCard
            dialog={dialog}
            inControl={youBrowser}
            onAnswer={answerDialog}
            onTakeControl={help === null && pause === null ? () => void takeControl() : undefined}
          />
        ) : null}

        <View style={[styles.stage, youShown ? styles.stageControl : null]}>
          {shown === "browser" ? (
            isLive ? (
              <View>
                <ComputerLiveView
                  ref={liveRef}
                  mode="browser"
                  url={urls?.browser ?? null}
                  interactive={youBrowser}
                  onPasswordField={passwordField}
                  fullScreen={false}
                  paused={!liveActive}
                  attemptKey={urlEpoch}
                  syncViewport={false}
                  onFrameSize={handleFrameSize}
                  onNeedsURL={refreshURLs}
                />
                {youBrowser ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open browser full screen"
                    onPress={() => openFullScreen("browser")}
                    style={StyleSheet.absoluteFill}
                  />
                )}
              </View>
            ) : (
              <StagePlaceholder
                stage={stage}
                canClose={toolbar.canClose}
                onTakeControl={status !== null ? () => void takeControl() : undefined}
                onCloseBrowser={() => void stop()}
              />
            )
          ) : desktopAvailable ? (
            <View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open desktop full screen"
                onPress={() => openFullScreen("desktop")}
              >
                <ComputerLiveView
                  mode="desktop"
                  url={urls?.desktop ?? null}
                  interactive={false}
                  fullScreen={false}
                  paused={!liveActive}
                  attemptKey={urlEpoch}
                  syncViewport={false}
                  onFrameSize={handleFrameSize}
                  onNeedsURL={refreshURLs}
                />
              </Pressable>
              <View style={styles.desktopBar}>
                <IconFocus2 size={15} color={tokens.textSecondary} />
                <Text style={styles.desktopBarText} numberOfLines={1}>
                  {desktopStatus?.focusedWindow?.title ?? "Desktop · watch only on phone"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open desktop full screen"
                  onPress={() => openFullScreen("desktop")}
                  style={styles.desktopExpandButton}
                >
                  <IconMaximize size={16} color={tokens.text} />
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.placeholder}>
              <View style={styles.placeholderBadge}>
                <IconDeviceLaptop size={22} color={tokens.textSecondary} />
              </View>
              <Text style={styles.placeholderText}>
                The live view needs the bots server on Windows or Omarchy.
              </Text>
            </View>
          )}
        </View>

        {browserToolbarVisible ? (
          <View style={styles.toolbar}>
            <View style={styles.addressBox}>
              {toolbar.secure ? (
                <IconLock size={14} color={tokens.working} />
              ) : (
                <IconWorld size={14} color={tokens.textSecondary} />
              )}
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
            {toolbar.canReload ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reload"
                onPress={sendReload}
                style={styles.toolButton}
              >
                <IconRefresh size={18} color={tokens.text} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open browser full screen"
              disabled={!isLive}
              onPress={() => openFullScreen("browser")}
              style={[styles.toolButton, !isLive ? styles.disabled : null]}
            >
              <IconMaximize size={18} color={tokens.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Browser options"
              onPress={() => setOptionsOpen(true)}
              style={styles.toolButton}
            >
              <IconDots size={18} color={tokens.textSecondary} />
            </Pressable>
          </View>
        ) : null}

        {showDriverCard ? (
          <DriverCard
            title={driverTitle(shownDriver, shown === "desktop" ? "Desktop" : "Brave")}
            line={driverLine({
              driver: shownDriver,
              events: shown === "desktop" ? desktopEventList : browserEventList,
              now,
            })}
            state={shownDriver.state}
            bot={avatarFor(shownDriver.botId)}
            queue={queue}
            onOpenChat={
              shownDriver.threadId !== null && shownDriver.botId !== null
                ? () => openChat(shownDriver.botId, shownDriver.threadId)
                : undefined
            }
            footer={
              shown === "browser" ? (
                <ComputerActions
                  inControl={false}
                  canTake
                  takeDisabled={actions.takeDisabled}
                  takeLabel={otherDevice ? "Take it here" : "Take control"}
                  handBackLabel="Hand back"
                  onTake={() => void takeControl()}
                  onHandBack={() => void handBack()}
                  stopLabel={null}
                  onStop={() => void stop()}
                  busy={stopBusy}
                />
              ) : actions.stopLabel === null ? null : (
                <ComputerActions
                  inControl={false}
                  canTake={false}
                  takeDisabled
                  handBackLabel="Hand back"
                  onTake={() => undefined}
                  onHandBack={() => undefined}
                  stopLabel={actions.stopLabel}
                  onStop={() => void stop()}
                  busy={stopBusy}
                />
              )
            }
          />
        ) : !nothingOnScreen && youBrowser ? (
          <>
            <ComputerActions
              inControl
              canTake
              takeDisabled={actions.takeDisabled}
              handBackLabel={
                queue.paused !== null && queue.paused.botName.length <= 14
                  ? `Hand back to ${queue.paused.botName}`
                  : "Hand back"
              }
              onTake={() => void takeControl()}
              onHandBack={() => void handBack()}
              stopLabel={null}
              onStop={() => void stop()}
              busy={stopBusy}
            />
            <QueueCard queue={queue} />
          </>
        ) : null}

        {!nothingOnScreen && otherDriver.state === "using" ? (
          <DriverCard
            title={otherDriver.botName ?? "A bot"}
            line={`${driverLine({
              driver: otherDriver,
              events: otherSource === "desktop" ? desktopEventList : browserEventList,
              now,
            })} · in the background`}
            state="using"
            bot={avatarFor(otherDriver.botId)}
            onPress={() => selectSource(otherSource)}
          />
        ) : null}

        {takeError !== null || actionError !== null || urlError !== null ? (
          <Text style={styles.error} maxFontSizeMultiplier={1.4}>
            {takeError ?? actionError ?? urlError}
          </Text>
        ) : null}

        <MachineStatsCard native={native} />

        <ActivityCard events={events} limit={5} onSeeAll={() => setActivityOpen(true)} />
      </ScrollView>

      <Modal
        visible={fullScreenVisible({ fullScreen: isFullScreen, inPip })}
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setFullScreenSource(null)}
      >
        <View style={[styles.fullScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.controlBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Exit full screen"
              onPress={() => setFullScreenSource(null)}
              style={styles.controlButton}
            >
              <Text style={styles.controlButtonText}>Exit</Text>
            </Pressable>
            <View style={styles.controlTitle}>
              <Text style={styles.controlTitleText} numberOfLines={1}>
                {modalHeader.title}
              </Text>
              {modalSource === "desktop" &&
              desktopStatus?.focusedWindow !== null &&
              desktopStatus?.focusedWindow !== undefined ? (
                <Text style={styles.controlSubtle} numberOfLines={1}>
                  {desktopStatus.focusedWindow.title}
                </Text>
              ) : modalSource === "browser" && help !== null ? (
                <Text style={styles.controlSubtitle} numberOfLines={1}>
                  {help.botName}: {help.reason}
                </Text>
              ) : modalSource === "browser" && !youBrowser && control.kind === "live" ? (
                <Text style={styles.controlSubtle} numberOfLines={1}>
                  {pageAddressLabel(status)}
                </Text>
              ) : null}
            </View>
            {modalHeader.action === "handBack" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Hand back"
                onPress={() => void handBack()}
                style={styles.handBack}
              >
                <Text style={styles.primaryButtonText}>Hand back</Text>
              </Pressable>
            ) : modalHeader.action === "takeControl" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Take control"
                disabled={actions.takeDisabled}
                onPress={() => void takeControl()}
                style={[styles.handBack, actions.takeDisabled ? styles.disabled : null]}
              >
                <Text style={styles.primaryButtonText}>Take control</Text>
              </Pressable>
            ) : modalHeader.badgeLabel !== null ? (
              <View style={styles.modalBadge}>
                <Text style={styles.modalBadgeText}>{modalHeader.badgeLabel}</Text>
              </View>
            ) : null}
          </View>

          {modalSource === "browser" && control.kind === "live" && youBrowser ? (
            <View style={styles.fullScreenToolbar}>
              <View style={styles.fullScreenAddressBox}>
                {toolbar.secure ? (
                  <IconLock size={14} color={tokens.working} />
                ) : (
                  <IconWorld size={14} color={tokens.textSecondary} />
                )}
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
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reload"
                disabled={!toolbar.canReload}
                onPress={sendReload}
                style={[styles.fullScreenToolButton, !toolbar.canReload ? styles.disabled : null]}
              >
                <IconRefresh size={16} color={tokens.text} />
              </Pressable>
            </View>
          ) : null}

          {modalSource === "browser" && dialog !== null ? (
            <PageDialogCard
              dialog={dialog}
              inControl={youBrowser}
              compact
              onAnswer={answerDialog}
              onTakeControl={() => void takeControl()}
            />
          ) : null}

          {modalSource === "desktop" ? (
            <ComputerLiveView
              ref={fullScreenLiveRef}
              mode="desktop"
              url={urls?.desktop ?? null}
              interactive={false}
              fullScreen
              paused={!appActive}
              attemptKey={urlEpoch}
              syncViewport={false}
              onFrameSize={handleFrameSize}
              onNeedsURL={refreshURLs}
            />
          ) : control.kind === "live" ? (
            <ComputerLiveView
              ref={fullScreenLiveRef}
              mode="browser"
              url={urls?.browser ?? null}
              interactive={youBrowser}
              onPasswordField={passwordField}
              fullScreen
              paused={!appActive}
              attemptKey={urlEpoch}
              syncViewport={youBrowser}
              onFrameSize={handleFrameSize}
              onNeedsURL={refreshURLs}
            />
          ) : (
            <View style={styles.controlMessage}>
              {control.kind === "waiting" ? (
                <ActivityIndicator color={tokens.textSecondary} />
              ) : null}
              <Text
                style={[
                  styles.controlMessageText,
                  control.kind === "error" ? styles.controlErrorText : null,
                ]}
              >
                {control.message}
              </Text>
              {control.kind === "error" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry taking control"
                  onPress={retryControl}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      </Modal>

      {/* The PiP window shows the live view and nothing else: no controls, no touch input. */}
      <Modal
        visible={inPip}
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => undefined}
      >
        <View style={styles.pipWindow}>
          <ComputerLiveView
            mode={pipSource}
            url={(pipSource === "browser" ? urls?.browser : urls?.desktop) ?? null}
            interactive={false}
            fullScreen
            paused={false}
            attemptKey={urlEpoch}
            syncViewport={false}
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
          label="Page forward"
          detail="Go to the next page in history"
          disabled={!toolbar.canForward}
          onPress={() => {
            activeLiveHandle()?.sendInput({ _tag: "Forward" });
            setOptionsOpen(false);
          }}
        />
        <SheetAction
          label="Escape"
          detail="Close a menu or dialog on the page"
          disabled={!toolbar.canEscape}
          onPress={() => {
            activeLiveHandle()?.sendInput({ _tag: "Key", key: "Escape" });
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

function StagePlaceholder({
  stage,
  canClose,
  onTakeControl,
  onCloseBrowser,
}: {
  readonly stage: BrowserStage;
  readonly canClose: boolean;
  readonly onTakeControl?: (() => void) | undefined;
  readonly onCloseBrowser: () => void;
}) {
  if (stage.kind === "live") return null;

  const isLoading = stage.kind === "starting" || stage.kind === "connecting";
  const isError = stage.kind === "crashed" || stage.kind === "locked";
  const isOffline = stage.kind === "offline";
  const isIdle = stage.kind === "idle";

  return (
    <View style={styles.placeholder}>
      <View
        style={[
          styles.placeholderBadge,
          isError ? styles.placeholderBadgeError : null,
          isOffline ? styles.placeholderBadgeMuted : null,
        ]}
      >
        {isLoading ? (
          <ActivityIndicator color={tokens.textSecondary} />
        ) : isError ? (
          <IconAlertTriangle size={22} color={tokens.reviewText} />
        ) : isOffline ? (
          <IconWifiOff size={22} color={tokens.textTertiary} />
        ) : (
          <IconWorld size={22} color={tokens.textSecondary} />
        )}
      </View>
      <Text style={styles.placeholderText}>{stage.message}</Text>
      {isIdle && onTakeControl !== undefined ? (
        <View style={styles.placeholderActions}>
          <Pressable
            accessibilityRole="button"
            onPress={onTakeControl}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Take control</Text>
          </Pressable>
        </View>
      ) : null}
      {isError ? (
        <View style={styles.placeholderActions}>
          {onTakeControl !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={onTakeControl}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          ) : null}
          {canClose ? (
            <Pressable
              accessibilityRole="button"
              onPress={onCloseBrowser}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Close browser</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
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
      return tokens.info;
    default:
      return tokens.textTertiary;
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
  header: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 2,
    backgroundColor: tokens.bg,
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  title: { color: tokens.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.4 },
  subtitle: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusPillText: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  body: { paddingHorizontal: 16, paddingTop: 6, gap: 12 },
  sourceBar: { flexDirection: "row", gap: 8, alignItems: "center" },
  segmentTrack: {
    flex: 1,
    flexDirection: "row",
    height: 44,
    borderRadius: 12,
    backgroundColor: tokens.fillMuted,
    padding: 3,
    gap: 3,
  },
  segmentTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 9,
  },
  segmentTabActive: {
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  segmentText: { color: tokens.textSecondary, fontSize: 14, fontWeight: "500" },
  segmentTextActive: { color: tokens.text, fontWeight: "600" },
  segmentLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.working },
  autoButton: {
    height: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  autoButtonOn: { borderColor: tokens.borderStrong, backgroundColor: tokens.surface },
  autoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.textTertiary },
  autoDotOn: { backgroundColor: tokens.working },
  autoText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  autoTextOn: { color: tokens.text, fontWeight: "600" },
  followToast: {
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: tokens.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  followToastText: { color: tokens.textSecondary, fontSize: 12, fontWeight: "500" },
  stage: {
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  stageControl: {
    borderWidth: 1.5,
    borderColor: tokens.info,
  },
  placeholder: { alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  placeholderBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderBadgeError: {
    backgroundColor: tokens.reviewBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.reviewBorder,
  },
  placeholderBadgeMuted: {
    backgroundColor: tokens.raised,
  },
  placeholderText: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  placeholderActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
  },
  primaryButton: {
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { color: tokens.primaryText, fontSize: 14, fontWeight: "700" },
  secondaryButton: {
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  desktopBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  desktopBarText: { flex: 1, color: tokens.textSecondary, fontSize: 12 },
  desktopExpandButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6 },
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
  addressText: { flex: 1, color: tokens.text, fontSize: 14 },
  addressInput: { flex: 1, color: tokens.text, fontSize: 14, padding: 0 },
  toolButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
  },
  disabled: { opacity: 0.4 },
  error: { color: tokens.danger, fontSize: 13 },
  fullScreen: { flex: 1, backgroundColor: tokens.bg },
  pipWindow: { flex: 1, backgroundColor: "#000000" },
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
  controlButtonText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  controlTitle: { flex: 1, gap: 1 },
  controlTitleText: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  controlSubtitle: { color: tokens.reviewText, fontSize: 12 },
  controlSubtle: { color: tokens.textSecondary, fontSize: 12 },
  modalBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    marginRight: 4,
  },
  modalBadgeText: { color: tokens.textSecondary, fontSize: 12, fontWeight: "600" },
  fullScreenToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: tokens.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  fullScreenAddressBox: {
    flex: 1,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 9,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 10,
  },
  fullScreenToolButton: {
    width: 36,
    height: 36,
    borderRadius: 9,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  controlMessage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 28,
  },
  controlMessageText: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  controlErrorText: { color: tokens.danger },
  handBack: {
    minHeight: 38,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
