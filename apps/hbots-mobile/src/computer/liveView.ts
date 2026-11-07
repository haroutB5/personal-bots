import type { PersonalBrowserInputMessage, PersonalDesktopViewInput } from "@t3tools/contracts";
import { PersonalBrowserInputMessage as BrowserInput } from "@t3tools/contracts";
import { PersonalDesktopViewInput as DesktopInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { requireNativeView } from "expo";
import type { Ref } from "react";
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native";

const encodeBrowserInput = Schema.encodeSync(Schema.fromJsonString(BrowserInput));
const encodeDesktopInput = Schema.encodeSync(Schema.fromJsonString(DesktopInput));

/** One JSON message for the browser viewport socket, validated against the contract. */
export function browserInput(message: PersonalBrowserInputMessage): string {
  return encodeBrowserInput(message);
}

/** One JSON message for the desktop viewport socket, validated against the contract. */
export function desktopInput(message: PersonalDesktopViewInput): string {
  return encodeDesktopInput(message);
}

export type LiveViewMode = "browser" | "desktop";

export interface LiveFrameEvent {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface FocusChangedEvent {
  readonly editable: boolean;
  readonly field?: string;
  readonly seq?: number;
}

export interface ViewStateEvent {
  readonly state: "live" | "locked" | "unavailable";
  readonly detail?: string;
}

export interface ControlEvent {
  readonly on: boolean;
  readonly detail?: string;
}

export interface LiveViewProps {
  readonly ref?: Ref<LiveViewHandle>;
  readonly url: string;
  readonly mode: LiveViewMode;
  /** No socket while the stage is off screen. */
  readonly paused?: boolean;
  /** Bumped by the screen when it mints a fresh ticket after a drop. */
  readonly attemptKey?: number;
  readonly interactive?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly onLiveOpen?: () => void;
  readonly onFrame?: (event: NativeSyntheticEvent<LiveFrameEvent>) => void;
  readonly onRejected?: (event: NativeSyntheticEvent<{ readonly reason: string }>) => void;
  readonly onHidden?: (event: NativeSyntheticEvent<{ readonly reason: string }>) => void;
  readonly onFocusChanged?: (event: NativeSyntheticEvent<FocusChangedEvent>) => void;
  readonly onClosed?: (event: NativeSyntheticEvent<{ readonly opened: boolean }>) => void;
  readonly onViewState?: (event: NativeSyntheticEvent<ViewStateEvent>) => void;
  readonly onControl?: (event: NativeSyntheticEvent<ControlEvent>) => void;
  readonly onInputRefused?: (event: NativeSyntheticEvent<{ readonly detail: string }>) => void;
  readonly onScrollEndWanted?: () => void;
}

export interface LiveViewHandle {
  send(message: string): void;
}

/**
 * The Kotlin view owns the socket, the JPEG decode and the drawing. JavaScript
 * never receives frame bytes: only the frame's size, so it can map a touch.
 */
export const NativeLiveView = requireNativeView<LiveViewProps>("HbotsLiveView");
