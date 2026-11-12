import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SlideUpIn } from "../motion/SlideUpIn";
import { tokens } from "../shell/tokens";

import { CallBar } from "./CallBar";
import { errorCopyFor } from "./callErrorCopy";
import {
  CALL_BAR_GAP,
  NOTICE_HEIGHT,
  callBarShowing,
  callIsOver,
  chevronAction,
} from "./callViewModel";
import { useCallSession, useCallView } from "./VoiceCallProvider";
import { VoiceCallScreen } from "./VoiceCallScreen";

export const VOICE_ENDED_HOLD_MS = 1_200;

export interface VoiceCallNavigation {
  readonly openChat: (botId: string, threadId: string) => void;
  readonly openSettings: () => void;
  readonly openBot: (botId: string) => void;
}

export function VoiceCallLayer({ navigation }: { readonly navigation: VoiceCallNavigation }) {
  const session = useCallSession();
  const view = useCallView();
  const call = view.call;
  const status = view.snapshot.state.status;
  const ended = call !== null && callIsOver(view.snapshot.state);

  useEffect(() => {
    if (!ended || session === null || call === null) return;
    const timer = setTimeout(() => {
      session.end();
      navigation.openChat(call.botId, call.threadId);
    }, VOICE_ENDED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [ended, session, call, navigation]);

  const error = useMemo(() => {
    if (session === null || call === null) return null;
    const leave = () => {
      session.end();
      navigation.openChat(call.botId, call.threadId);
    };
    return errorCopyFor(view.snapshot.state.errorCode, view.micRefusal, {
      onSettings: () => {
        session.end();
        navigation.openSettings();
      },
      onBotPage: () => {
        session.end();
        navigation.openBot(call.botId);
      },
      onRetry: () => {
        const request = {
          threadId: call.threadId,
          botId: call.botId,
          botName: call.botName,
          avatarShape: call.avatarShape,
          avatarColor: call.avatarColor,
        };
        session.end();
        void session.start(request);
      },
      onClose: leave,
      onOpenAppSettings: () => session.openAppSettings(),
    });
  }, [session, call, navigation, view.snapshot.state.errorCode, view.micRefusal]);

  if (session === null) return null;
  if (call === null) {
    return view.recovered ? <RecoveredNotice onDismiss={session.dismissRecovered} /> : null;
  }

  if (callBarShowing(view)) {
    return (
      <CallBar
        view={view}
        onReturn={() => session.setMinimised(false)}
        onToggleMute={session.toggleMute}
        onEnd={() => session.end("hung_up")}
      />
    );
  }

  return (
    <SlideUpIn>
      <VoiceCallScreen
        view={view}
        error={error}
        maxCallMinutes={view.snapshot.maxCallMinutes}
        onMinimise={() => {
          if (chevronAction(status) === "leave") {
            session.end();
            navigation.openChat(call.botId, call.threadId);
            return;
          }
          session.setMinimised(true);
        }}
        onToggleCaptions={() => session.setCaptionsOn(!view.captionsOn)}
        onToggleMute={session.toggleMute}
        onEnd={() => session.end("hung_up")}
        onUndo={session.undoSend}
        onOpenChat={() => {
          session.setMinimised(true);
          navigation.openChat(call.botId, call.threadId);
        }}
        onDismissRecovered={session.dismissRecovered}
        readLevel={session.readLevel}
      />
    </SlideUpIn>
  );
}

function RecoveredNotice({ onDismiss }: { readonly onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.notice, { top: insets.top + CALL_BAR_GAP }]} pointerEvents="box-none">
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss: your last call ended when hbots was closed"
        style={styles.noticeBody}
      >
        <Text style={styles.noticeText} maxFontSizeMultiplier={1.4}>
          Your last call ended when hbots was closed.
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { position: "absolute", left: 8, right: 8 },
  noticeBody: {
    height: NOTICE_HEIGHT,
    borderRadius: NOTICE_HEIGHT / 2,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.raised,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  noticeText: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19, textAlign: "center" },
});
