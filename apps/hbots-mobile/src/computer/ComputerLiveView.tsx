import type { PersonalBrowserInputMessage } from "@t3tools/contracts";
import { fitFrame } from "@hbots/personal-client/computer/computerModel";
import { IconArrowLeft, IconKeyboard } from "@tabler/icons-react-native";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import {
  PanResponder,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import {
  browserInput,
  desktopInput,
  NativeLiveView,
  type FocusChangedEvent,
  type LiveViewHandle,
  type LiveViewMode,
} from "./liveView";

const DEFAULT_ASPECT = 390 / 560;
const SCROLL_SLOP_PX = 8;
const TOAST_MS = 2400;
const MAX_RECONNECTS = 5;
const VIEWPORT_DEBOUNCE_MS = 250;

export interface ComputerLiveViewHandle extends LiveViewHandle {
  /** Sends one browser input, or does nothing while the socket is closed. */
  sendInput(message: PersonalBrowserInputMessage): void;
}

export function ComputerLiveView({
  ref,
  mode,
  url,
  interactive,
  fullScreen,
  paused,
  attemptKey,
  syncViewport,
  onClosed,
  onNeedsURL,
}: {
  readonly ref?: Ref<ComputerLiveViewHandle>;
  readonly mode: LiveViewMode;
  readonly url: string | null;
  readonly interactive: boolean;
  readonly fullScreen: boolean;
  readonly paused: boolean;
  readonly attemptKey: number;
  /** Browser full screen in control: ask the page to lay out for this box. */
  readonly syncViewport: boolean;
  readonly onClosed?: () => void;
  readonly onNeedsURL: () => void;
}) {
  const liveRef = useRef<LiveViewHandle>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const boxRef = useRef(box);
  // eslint-disable-next-line react/refs -- latest-value ref read by native callbacks
  boxRef.current = box;
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [notice, setNotice] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [field, setField] = useState<string>("text");
  const [keysOpen, setKeysOpen] = useState(false);
  const failures = useRef(0);
  const scrollEndWanted = useRef(false);
  const metaRef = useRef<{ width: number; height: number } | null>(null);
  const interactiveRef = useRef(interactive);
  // eslint-disable-next-line react/refs -- latest-value ref read by native callbacks
  interactiveRef.current = interactive;
  const alive = useRef(true);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = (message: PersonalBrowserInputMessage) => {
    liveRef.current?.send(browserInput(message));
  };

  useImperativeHandle(ref, () => ({
    send: (message: string) => liveRef.current?.send(message),
    sendInput: (message: PersonalBrowserInputMessage) => send(message),
  }));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
    };
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- a new URL starts a fresh attempt
    setGaveUp(false);
    failures.current = 0;
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- attemptKey deliberately restarts the attempt
  }, [url, attemptKey]);

  /** The page lays out for the phone only while it controls the browser. */
  const requestViewport = () => {
    const { width, height } = boxRef.current;
    if (width <= 0 || height <= 0) return;
    if (mode === "desktop") {
      const ratio = PixelRatio.get();
      liveRef.current?.send(
        desktopInput({
          _tag: "Viewport",
          width: Math.round(width * ratio),
          height: Math.round(height * ratio),
        }),
      );
      return;
    }
    if (!syncViewport || !interactiveRef.current) return;
    liveRef.current?.send(
      browserInput({ _tag: "Viewport", width: Math.round(width), height: Math.round(height) }),
    );
  };

  const planViewport = () => {
    if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(requestViewport, VIEWPORT_DEBOUNCE_MS);
  };

  const frame = (event: NativeSyntheticEvent<{ width: number; height: number; scale: number }>) => {
    const next = event.nativeEvent;
    metaRef.current = { width: next.width, height: next.height };
    setAspect((previous) => {
      const ratio = next.width / next.height;
      return Math.abs(previous - ratio) < 0.001 ? previous : ratio;
    });
    setNotice(null);
  };

  const closed = (event: NativeSyntheticEvent<{ opened: boolean }>) => {
    onClosed?.();
    if (event.nativeEvent.opened) {
      failures.current = 0;
    } else {
      failures.current += 1;
      if (failures.current >= MAX_RECONNECTS) {
        setGaveUp(true);
        return;
      }
    }
    retryTimer.current = setTimeout(() => {
      if (alive.current) onNeedsURL();
    }, 1500);
  };

  const focusChanged = (event: NativeSyntheticEvent<FocusChangedEvent>) => {
    const next = event.nativeEvent;
    setField(next.field ?? "text");
    if (!next.editable) setKeyboardOpen(false);
  };

  const fitted = fullScreen && box.width > 0 && box.height > 0 ? fitFrame(box, aspect) : null;

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== box.width || height !== box.height) {
      boxRef.current = { width, height };
      setBox({ width, height });
      planViewport();
    }
  };

  const point = (x: number, y: number) => {
    const meta = metaRef.current;
    const current = boxRef.current;
    if (meta === null || current.width <= 0 || current.height <= 0) return null;
    return {
      x: x * (meta.width / current.width),
      y: y * (meta.height / current.height),
      scaleX: meta.width / current.width,
      scaleY: meta.height / current.height,
    };
  };

  const gesture = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    scrolling: boolean;
  } | null>(null);

  const responder = useRef(
    // eslint-disable-next-line react/refs -- the responder is created once
    PanResponder.create({
      onStartShouldSetPanResponder: () => interactiveRef.current,
      onMoveShouldSetPanResponder: () => interactiveRef.current,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        gesture.current = {
          startX: locationX,
          startY: locationY,
          lastX: locationX,
          lastY: locationY,
          scrolling: false,
        };
      },
      onPanResponderMove: (event) => {
        const current = gesture.current;
        if (current === null) return;
        const { locationX, locationY } = event.nativeEvent;
        if (
          !current.scrolling &&
          Math.hypot(locationX - current.startX, locationY - current.startY) > SCROLL_SLOP_PX
        ) {
          current.scrolling = true;
        }
        if (current.scrolling) {
          const mapped = point(locationX, locationY);
          if (mapped !== null) {
            send({
              _tag: "Wheel",
              x: mapped.x,
              y: mapped.y,
              deltaX: (current.lastX - locationX) * mapped.scaleX,
              deltaY: (current.lastY - locationY) * mapped.scaleY,
            });
          }
        }
        current.lastX = locationX;
        current.lastY = locationY;
      },
      onPanResponderRelease: (event) => {
        const current = gesture.current;
        gesture.current = null;
        if (current === null) return;
        const { locationX, locationY } = event.nativeEvent;
        if (current.scrolling) {
          if (scrollEndWanted.current) send({ _tag: "ScrollEnd" });
          return;
        }
        const mapped = point(locationX, locationY);
        if (mapped !== null) send({ _tag: "Pointer", action: "tap", x: mapped.x, y: mapped.y });
      },
      onPanResponderTerminate: () => {
        const current = gesture.current;
        gesture.current = null;
        if (current?.scrolling === true && scrollEndWanted.current) send({ _tag: "ScrollEnd" });
      },
    }),
  ).current;

  return (
    <View
      style={[styles.root, fullScreen ? styles.fullRoot : { aspectRatio: aspect }]}
      onLayout={onLayout}
    >
      <View
        style={
          fitted === null
            ? styles.fill
            : { width: fitted.width, height: fitted.height, alignSelf: "center" }
        }
      >
        {url === null ? (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Opening the live view…</Text>
          </View>
        ) : (
          <NativeLiveView
            ref={liveRef}
            style={styles.fill}
            url={url}
            mode={mode}
            interactive={interactive}
            paused={paused}
            attemptKey={attemptKey}
            onLiveOpen={requestViewport}
            onFrame={frame}
            onRejected={(event) => setNotice(event.nativeEvent.reason)}
            onHidden={(event) => setNotice(event.nativeEvent.reason)}
            onFocusChanged={focusChanged}
            onClosed={closed}
            onScrollEndWanted={() => {
              scrollEndWanted.current = true;
            }}
            onInputRefused={(event) => setNotice(event.nativeEvent.detail)}
            onViewState={(event) => {
              if (event.nativeEvent.state === "live") setNotice(null);
              else setNotice(event.nativeEvent.detail ?? "The PC screen is not available.");
            }}
          />
        )}
        {/* eslint-disable-next-line react/refs -- pan handlers are stable for the component lifetime */}
        {interactive ? <View style={styles.fill} {...responder.panHandlers} /> : null}
        {interactive ? (
          <TextInput
            style={styles.hiddenField}
            value=""
            onFocus={() => setKeyboardOpen(true)}
            onBlur={() => setKeyboardOpen(false)}
            onChangeText={(text) => {
              if (text.length > 0) send({ _tag: "InsertText", text });
            }}
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key === "Backspace" || key === "Enter" || key === "Tab" || key === "Escape") {
                send({ _tag: "Key", key });
              }
            }}
            onSubmitEditing={() => send({ _tag: "Key", key: "Enter" })}
            keyboardType={keyboardType(field)}
            secureTextEntry={field === "password"}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            showSoftInputOnFocus
          />
        ) : null}
      </View>

      {notice !== null || gaveUp ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} numberOfLines={3}>
            {gaveUp ? "Live view disconnected." : notice}
          </Text>
          {gaveUp ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                failures.current = 0;
                setGaveUp(false);
                onNeedsURL();
              }}
            >
              <Text style={styles.noticeAction}>Reconnect</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {interactive ? (
        <View style={styles.dock}>
          <DockButton
            label={keyboardOpen ? "Hide keyboard" : "Show keyboard"}
            active={keyboardOpen}
            onPress={() => setKeyboardOpen((open) => !open)}
          >
            <IconKeyboard size={18} color={keyboardOpen ? tokens.primaryText : tokens.text} />
          </DockButton>
          <DockButton label="Page back" onPress={() => send({ _tag: "Back" })}>
            <IconArrowLeft size={18} color={tokens.text} />
          </DockButton>
          <DockButton label="Tab" onPress={() => send({ _tag: "Key", key: "Tab" })}>
            <Text style={styles.dockText}>Tab</Text>
          </DockButton>
          <DockButton label="Enter" onPress={() => send({ _tag: "Key", key: "Enter" })}>
            <Text style={styles.dockText}>Enter</Text>
          </DockButton>
          <DockButton label="More keys" onPress={() => setKeysOpen(true)}>
            <Text style={styles.dockText}>More</Text>
          </DockButton>
        </View>
      ) : null}

      <SheetShell visible={keysOpen} title="Browser keys" onClose={() => setKeysOpen(false)}>
        <SheetAction
          label="Page forward"
          detail="Go to the next page in history"
          onPress={() => {
            send({ _tag: "Forward" });
            setKeysOpen(false);
          }}
        />
        <SheetAction
          label="Reload"
          detail="Reload the page"
          onPress={() => {
            send({ _tag: "Reload" });
            setKeysOpen(false);
          }}
        />
        <SheetAction
          label="Escape"
          detail="Close a menu or dialog on the page"
          onPress={() => {
            send({ _tag: "Key", key: "Escape" });
            setKeysOpen(false);
          }}
        />
        <SheetAction
          label="Backspace"
          detail="Delete the character before the cursor"
          onPress={() => {
            send({ _tag: "Key", key: "Backspace" });
            setKeysOpen(false);
          }}
        />
      </SheetShell>
    </View>
  );
}

function keyboardType(field: string) {
  switch (field) {
    case "email":
      return "email-address" as const;
    case "numeric":
    case "decimal":
      return "decimal-pad" as const;
    case "tel":
      return "phone-pad" as const;
    case "url":
      return "url" as const;
    default:
      return "default" as const;
  }
}

function DockButton({
  label,
  active = false,
  onPress,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.dockButton, active ? styles.dockButtonActive : null]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { width: "100%", backgroundColor: "#000", position: "relative", overflow: "hidden" },
  fullRoot: { flex: 1, alignItems: "center", justifyContent: "center" },
  fill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { color: tokens.textSecondary, fontSize: 14 },
  hiddenField: { position: "absolute", width: 1, height: 1, opacity: 0, bottom: 0, left: 0 },
  notice: {
    position: "absolute",
    top: 8,
    left: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  noticeText: { flex: 1, color: tokens.text, fontSize: 13 },
  noticeAction: { color: tokens.text, fontSize: 13, fontWeight: "700" },
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "rgba(15,15,14,0.86)",
  },
  dockButton: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  dockButtonActive: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  dockText: { color: tokens.text, fontSize: 13, fontWeight: "600" },
});
