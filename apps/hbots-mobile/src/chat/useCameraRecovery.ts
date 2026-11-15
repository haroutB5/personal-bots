import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { cameraRecoveryDecision, type RecoveryChat } from "./cameraRecovery";
import { HbotsCamera } from "./hbotsCamera";

/**
 * After an activity destroy or a process kill the launch record is still on the phone. A fresh
 * record opens the chat that launched the camera, so that chat's composer mounts and claims the
 * photo; a record whose chat is gone is dropped with its file. The check runs when the app first
 * becomes ready and on every return to the foreground, which covers both lifecycles.
 */
export function useCameraRecovery(input: {
  readonly native: NativePersonal;
  readonly ready: boolean;
  readonly openChat: (botId: string, threadId: string) => boolean;
}): void {
  const list = input.native.bots.usePersonalBotsList(input.native.environmentId);
  const chats = useMemo<ReadonlyArray<RecoveryChat> | null>(() => {
    if (list.data === null) return null;
    return list.data.threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => ({ botId: thread.botId, threadId: thread.threadId }));
  }, [list.data]);
  const handled = useRef<string | null>(null);
  const openChat = useRef(input.openChat);
  const ready = useRef(input.ready);
  const { native } = input;

  useEffect(() => {
    openChat.current = input.openChat;
  }, [input.openChat]);

  useEffect(() => {
    ready.current = input.ready;
  }, [input.ready]);

  const recover = useCallback(async () => {
    if (!ready.current) return;
    const launch = await HbotsCamera.pending().catch(() => null);
    if (launch === null) {
      handled.current = null;
      return;
    }
    const key = `${launch.owner}@${launch.at}`;
    if (handled.current === key) return;
    const decision = cameraRecoveryDecision({
      launch,
      environmentId: native.environmentId,
      now: Date.now(),
      chats,
    });
    switch (decision.kind) {
      case "none":
      case "wait":
        return;
      case "leave":
        handled.current = key;
        return;
      case "drop":
        handled.current = key;
        await HbotsCamera.discard(launch.owner).catch(() => undefined);
        return;
      case "open":
        if (openChat.current(decision.botId, decision.threadId)) handled.current = key;
        return;
    }
  }, [chats, native.environmentId]);

  useEffect(() => {
    if (!input.ready) return;
    void recover();
  }, [input.ready, recover]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void recover();
    });
    return () => subscription.remove();
  }, [recover]);
}
