import {
  CommandId,
  MessageId,
  ThreadId,
  botEffectiveModelSelection,
  personalReplyContext,
  withPersonalFollowUp,
  type ChatAttachment,
  type PersonalBot,
  type PersonalReplyQuote,
} from "@t3tools/contracts";
import type { ThreadTurnFollowUp } from "@hbots/personal-client/conversation/wireTypes";
import type { ChatThread } from "@hbots/personal-client/conversation/chatThread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  enqueueOutboxEntry,
  hasOutboxForThread,
  newOutboxId,
  outboxCommandId,
  type OutboxEntry,
} from "@hbots/personal-client/composer/outbox";
import { classifySendFailure } from "@hbots/personal-client/composer/outboxFlush";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@hbots/personal-client/feed/composerText";
import { IconArrowUp, IconFile, IconPaperclip, IconPlus, IconSquare, IconX } from "../ui/icons";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { ChatEnvironment } from "./chatEnvironment";
import {
  addStoredOutgoing,
  awaitAck,
  beginSend,
  forgetOutgoingKey,
  hasDraftContent,
  mergePending,
  OUTGOING_INDEX_KEY,
  outgoingFromStored,
  outgoingStorageKey,
  parseStoredOutgoing,
  pendingSend,
  rememberOutgoingKey,
  removePending,
  removeStoredOutgoing,
  restoreDraft,
  retrySend,
  sendMetaFromStored,
  setPendingState,
  settle,
  type AckEnd,
  type ComposerDraft,
  type Outgoing,
  type PendingSend,
  type SendMeta,
} from "./composerSendModel";
import { uploadDraftAttachments, type DraftAttachment } from "./outboxNative";
import { discardOutgoingFiles, readableOutgoingFiles, retainOutgoingFiles } from "./outgoingFiles";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { attachmentName } from "./attachmentName";
import { PrewarmAttachmentImages } from "./AttachmentImage";
import { AttachSheet } from "./AttachSheet";
import {
  attachPhotos,
  cameraRefusal,
  libraryPick,
  plainNotice,
  type ComposerNotice,
} from "./attachSheetModel";
import { CameraCaptureSheet } from "./CameraCaptureSheet";
import {
  CAMERA_OPEN_MS,
  cameraFailure,
  cameraLaunchDecision,
  cameraLaunchNotice,
  claimAction,
  launchClaimAllowed,
  photoLaunchNotice,
  watchCameraLaunch,
} from "./cameraLaunch";
import { HbotsCamera } from "./hbotsCamera";
import { ComposerHost } from "./ComposerHost";
import { embeddedPickerAvailable } from "./PhotoStrip";
import { keyboardImages, releasedIntakes } from "./composerInput";
import { localImages } from "./localImages";
import { shrinkDrafts } from "./photoDrafts";
import { photosToWarm } from "./photoThumb";
import { draftKey } from "./linkDraft";
import { blockedMessage } from "../share/pickerModel";
import { discardCameraDraft, discardShare, readShare, shrinkPhoto } from "../share/shareIntake";
import { SheetAction, SheetCancel, SheetShell } from "../sheets/SheetShell";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DRAFT_DEBOUNCE_MS = 400;
const MAX_TITLE_SEED = 80;

function titleSeedFor(text: string, attachments: ReadonlyArray<DraftAttachment>): string {
  const seed =
    text.trim().length > 0
      ? text.trim()
      : attachments[0] === undefined
        ? "New chat"
        : `${attachments[0].kind === "image" ? "Image" : "File"}: ${attachments[0].name}`;
  return seed.slice(0, MAX_TITLE_SEED);
}

function sizeOf(uri: string, fallback: number): number {
  if (fallback > 0) return fallback;
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/** Sends a plain message without touching the draft; used by tap-to-answer choices. */
export interface ComposerControl {
  readonly sendText: (text: string) => Promise<boolean>;
  /** Sends a failed bubble again under the same message id. */
  readonly retry: (id: string) => Promise<boolean>;
  /** Drops a bubble once the transcript shows the message arrived. */
  readonly forget: (id: string) => void;
}

interface ActiveSend {
  readonly outgoing: Outgoing;
  readonly meta: SendMeta;
}

export function Composer({
  native,
  chat,
  thread,
  threadId,
  bot,
  botName,
  working,
  supportsActiveSteering = true,
  replyTo,
  onClearReply,
  onPendingChange,
  onSendError,
  onInterrupt,
  onSent,
  control,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly thread: ChatThread;
  readonly threadId: string;
  readonly bot: PersonalBot | null;
  readonly botName: string;
  readonly working: boolean;
  readonly supportsActiveSteering?: boolean;
  readonly replyTo: PersonalReplyQuote | null;
  readonly onClearReply: () => void;
  readonly onPendingChange: (
    update: (pending: ReadonlyArray<PendingSend>) => ReadonlyArray<PendingSend>,
  ) => void;
  readonly onSendError: (message: string | null) => void;
  readonly onInterrupt: () => Promise<void>;
  readonly onSent: () => void;
  readonly control?: { current: ComposerControl | null } | undefined;
}) {
  const key = draftKey(native.environmentId, threadId);
  const outgoingKey = outgoingStorageKey(native.environmentId, threadId);
  const [draft, setDraftState] = useState<ComposerDraft>(() => ({
    text: native.client.ports.kv.getItem(key) ?? "",
    attachments: [],
  }));
  const draftRef = useRef<ComposerDraft>(draft);
  const activeSends = useRef(new Map<string, ActiveSend>());
  const sendAborts = useRef(new Map<string, AbortController>());
  const claimedIntakes = useRef(new Map<string, Map<string, string>>());
  const setDraft = (update: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => {
    const next = typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    setDraftState(next);
  };
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [capture, setCapture] = useState<{ readonly reason: string | null } | null>(null);
  const [embedded, setEmbedded] = useState(embeddedPickerAvailable);
  const [previewAttachment, setPreviewAttachment] = useState<DraftAttachment | null>(null);
  const systemCameraStuck = useRef<string | null>(null);
  const cameraLaunching = useRef(false);
  const connection = native.useConnectionState();
  const startTurn = native.client.useAtomCommand(chat.thread.startTurn, {
    reportFailure: false,
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offline = connection.phase !== "connected";
  const text = draft.text;
  const attachments = draft.attachments;

  useEffect(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (text.length === 0) native.client.ports.kv.removeItem(key);
      else native.client.ports.kv.setItem(key, text);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, [key, native, text]);

  // A send that outlived the screen comes back as a failed bubble with its text.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = parseStoredOutgoing(native.client.ports.kv.getItem(outgoingKey));
    if (stored.length === 0) return;
    const restoredSends = stored.map((item) => ({
      outgoing: outgoingFromStored(item),
      meta: sendMetaFromStored(item),
    }));
    for (const item of restoredSends) {
      activeSends.current.set(item.outgoing.id, item);
    }
    onPendingChange((pending) =>
      mergePending(
        pending,
        restoredSends.map((item) =>
          pendingSend(
            item.outgoing,
            threadId,
            item.outgoing.text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          ),
        ),
      ),
    );
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- restore once per composer mount
  }, []);

  // Keyboard images wait in the share intake dir until the draft lets go of them.
  const intakeHeld = useRef(new Map<string, string>());

  useEffect(() => {
    for (const intakeId of releasedIntakes(intakeHeld.current, attachments)) {
      discardShare(intakeId);
      for (const [attachmentId, held] of intakeHeld.current) {
        if (held === intakeId) intakeHeld.current.delete(attachmentId);
      }
    }
  }, [attachments]);

  useEffect(() => {
    const held = intakeHeld.current;
    return () => {
      for (const intakeId of new Set(held.values())) discardShare(intakeId);
      held.clear();
    };
  }, []);

  useEffect(() => {
    const aborts = sendAborts.current;
    return () => {
      for (const abort of aborts.values()) abort.abort();
      aborts.clear();
    };
  }, []);

  const hasContent = hasDraftContent(draft);
  const showStop = working && !hasContent;
  const canSend = hasContent && !preparing;

  /**
   * The one way into the draft, from every source: photos are shrunk first, then the size cap
   * applies. Keyboard and embedded-picker images keep their intake folder until the draft lets
   * go of them.
   */
  const addDrafts = async (next: ReadonlyArray<DraftAttachment>, intakeId: string | null) => {
    const shrunk = await shrinkDrafts(next, shrinkPhoto);
    const tooBig = shrunk.filter((attachment) => attachment.sizeBytes > MAX_ATTACHMENT_BYTES);
    if (tooBig.length > 0) {
      if (intakeId !== null) discardShare(intakeId);
      setNotice(
        plainNotice(`Files must be 25 MB or less: ${tooBig.map((item) => item.name).join(", ")}`),
      );
      return;
    }
    if (intakeId !== null) {
      for (const draft of shrunk) intakeHeld.current.set(draft.id, intakeId);
      setNotice(null);
    }
    setDraft((draft) => ({ ...draft, attachments: [...draft.attachments, ...shrunk] }));
  };

  const addPicked = async (next: ReadonlyArray<DraftAttachment>) => {
    const room = MAX_ATTACHMENTS - draftRef.current.attachments.length;
    await addDrafts(next.slice(0, Math.max(0, room)), null);
  };

  const addCameraAsset = async (
    asset: {
      readonly uri: string;
      readonly fileName?: string | null;
      readonly fileSize?: number;
    },
    source: string,
  ) => {
    await addPicked([
      {
        id: `${Date.now()}-${source}`,
        kind: "image",
        name: attachmentName({ fileName: asset.fileName, camera: true, index: 0 }),
        mimeType: "image/jpeg",
        sizeBytes: sizeOf(asset.uri, asset.fileSize ?? 0),
        uri: asset.uri,
      },
    ]);
  };

  const cameraOwner = `${native.environmentId}/${threadId}`;

  const claimCameraPhoto = async (source: string, allowed = true): Promise<boolean> => {
    if (!allowed) return false;
    const action = claimAction(await HbotsCamera.claim(cameraOwner));
    if (action.kind === "log") {
      console.info(`[camera] ${action.reason}`);
      return false;
    }
    if (action.kind === "none") return false;
    console.info(`[camera] claim source=${source} bytes=${action.bytes}`);
    await addCameraAsset({ uri: action.uri, fileSize: action.bytes, fileName: null }, source);
    return true;
  };

  // Android can destroy this activity or kill the process during a system camera launch. The
  // native module recorded the launching chat and the photo file before the camera opened, so
  // the composer that mounts next claims the photo once. The r4 kv marker is cleared here.
  const pendingChecked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (pendingChecked.current) return;
    pendingChecked.current = true;
    native.client.ports.kv.removeItem(`t3code:camera-launch:v1:${native.environmentId}`);
    void (async () => {
      try {
        await claimCameraPhoto("recovered");
      } catch (error) {
        const failure = cameraFailure(error);
        console.warn(`[camera] claim failed code=${failure.code} message=${failure.message}`);
      }
    })();
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- claim once per composer mount
  }, []);

  /** An image from the keyboard: the share intake's caps and refusals, then a draft attachment. */
  const addKeyboardImages = (intakeId: string | null) => {
    if (intakeId === null) {
      setNotice(plainNotice(blockedMessage("empty")));
      return;
    }
    const result = keyboardImages(readShare(intakeId), (index) => {
      return `${Date.now()}-kb${index}-${Math.random().toString(36).slice(2, 8)}`;
    });
    if (!result.ok) {
      discardShare(intakeId);
      setNotice(plainNotice(result.message));
      return;
    }
    if (draftRef.current.attachments.length + result.drafts.length > MAX_ATTACHMENTS) {
      discardShare(intakeId);
      setNotice(plainNotice(blockedMessage("too-many-items")));
      return;
    }
    void addDrafts(result.drafts, intakeId);
  };

  const pickPhotos = async () => {
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        ...libraryPick(MAX_ATTACHMENTS - draftRef.current.attachments.length),
        quality: 1,
      });
      if (result.canceled) return;
      await addPicked(
        result.assets.map((asset, index) => {
          const uri = asset.uri;
          const name = attachmentName({
            fileName: asset.fileName,
            camera: false,
            index,
          });
          return {
            id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "image",
            name,
            mimeType: asset.mimeType ?? "image/jpeg",
            sizeBytes: sizeOf(uri, asset.fileSize ?? 0),
            uri,
          };
        }),
      );
    } catch (error) {
      const failure = cameraFailure(error);
      console.warn(`[photos] launch failed code=${failure.code} message=${failure.message}`);
      if (embeddedPickerAvailable()) {
        setEmbedded(true);
        setAttachOpen(true);
      } else {
        setNotice(photoLaunchNotice(failure));
      }
    } finally {
      setPicking(false);
    }
  };

  const cameraPermission = async () => {
    const current = await ImagePicker.getCameraPermissionsAsync();
    if (current.granted) return current;
    return ImagePicker.requestCameraPermissionsAsync();
  };

  /**
   * The camera intent stays pending when no camera app takes the screen, so a launch still
   * pending after CAMERA_OPEN_MS of foreground time opens the in-app camera instead. The camera
   * taking the screen stops that wait, and a real rejection opens the in-app camera at once.
   */
  const launchSystemCamera = async () => {
    const watch = watchCameraLaunch({
      stallMs: CAMERA_OPEN_MS,
      isForeground: () => AppState.currentState === "active",
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") watch.background();
    });
    const launch = HbotsCamera.launch(cameraOwner);
    void launch.then(
      (saved) => watch.settle(saved ? { kind: "succeeded" } : { kind: "cancelled" }),
      (error) => watch.settle({ kind: "rejected", failure: cameraFailure(error) }),
    );

    const outcome = await watch.outcome;
    appState.remove();
    const decision = cameraLaunchDecision(outcome);
    if (decision.kind === "stop") return;
    if (decision.kind === "accept") {
      await claimCameraPhoto("camera", launchClaimAllowed(mounted.current));
      return;
    }

    if (outcome.kind === "rejected") {
      const failure = outcome.failure;
      console.warn(`[camera] launch failed code=${failure.code} message=${failure.message}`);
      setNotice(cameraLaunchNotice(failure));
      setCapture({ reason: decision.reason });
      return;
    }
    if (outcome.kind !== "timeout") return;

    console.warn(`[camera] launch stalled after ${CAMERA_OPEN_MS}ms`);
    systemCameraStuck.current = decision.reason;
    setCapture({ reason: decision.reason });
    // A system camera that opens after the wait still wins: its photo closes the sheet.
    void launch.then(
      (saved) => {
        if (!saved || !launchClaimAllowed(mounted.current)) return;
        void claimCameraPhoto("late").then((added) => {
          if (added) setCapture(null);
        });
      },
      (error) => {
        const failure = cameraFailure(error);
        console.warn(`[camera] launch failed code=${failure.code} message=${failure.message}`);
      },
    );
  };

  const pickCamera = async () => {
    if (cameraLaunching.current) return;
    cameraLaunching.current = true;
    setPicking(true);
    try {
      const refusal = cameraRefusal(await cameraPermission());
      if (refusal !== null) {
        setNotice(refusal);
        return;
      }
      if (systemCameraStuck.current !== null) {
        setNotice(null);
        setCapture({ reason: systemCameraStuck.current });
        return;
      }
      await launchSystemCamera();
    } catch (error) {
      const failure = cameraFailure(error);
      console.warn(`[camera] launch failed code=${failure.code} message=${failure.message}`);
      setNotice(cameraLaunchNotice(failure));
    } finally {
      cameraLaunching.current = false;
      setPicking(false);
    }
  };

  const pickFiles = async () => {
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      await addPicked(
        result.assets.map((asset, index) => {
          const name = asset.name ?? `File ${index + 1}`;
          const mimeType = asset.mimeType ?? "application/octet-stream";
          return {
            id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            kind: mimeType.startsWith("image/") ? "image" : "file",
            name,
            mimeType,
            sizeBytes: sizeOf(asset.uri, asset.size ?? 0),
            uri: asset.uri,
          };
        }),
      );
    } catch {
      setNotice(plainNotice("Couldn't open the file picker."));
    } finally {
      setPicking(false);
    }
  };

  const claimIntakes = (messageId: string, snapshot: ReadonlyArray<DraftAttachment>) => {
    const claimed = new Map<string, string>();
    for (const attachment of snapshot) {
      const intakeId = intakeHeld.current.get(attachment.id);
      if (intakeId === undefined) continue;
      intakeHeld.current.delete(attachment.id);
      claimed.set(attachment.id, intakeId);
    }
    if (claimed.size > 0) claimedIntakes.current.set(messageId, claimed);
  };

  const discardClaimedIntakes = (messageId: string) => {
    const claimed = claimedIntakes.current.get(messageId);
    if (claimed === undefined) return;
    claimedIntakes.current.delete(messageId);
    for (const intakeId of new Set(claimed.values())) discardShare(intakeId);
  };

  const reholdClaimedIntakes = (messageId: string) => {
    const claimed = claimedIntakes.current.get(messageId);
    if (claimed === undefined) return;
    claimedIntakes.current.delete(messageId);
    for (const [attachmentId, intakeId] of claimed) intakeHeld.current.set(attachmentId, intakeId);
  };

  // The outbox kept its own copy, so a sent or dropped draft's camera copy can go.
  const releaseDraftCopies = (snapshot: ReadonlyArray<DraftAttachment>) => {
    for (const attachment of snapshot) discardCameraDraft(attachment.uri);
  };

  const queue = async (
    messageId: string,
    textValue: string,
    createdAt: string,
    followUp: ThreadTurnFollowUp | null,
    snapshot: ReadonlyArray<DraftAttachment>,
    quote: PersonalReplyQuote | null,
  ): Promise<boolean> => {
    try {
      const entry: OutboxEntry | null = enqueueOutboxEntry({
        id: messageId,
        commandId: outboxCommandId(messageId),
        kind: "turn",
        environmentId: native.environmentId,
        threadId,
        groupId: null,
        text: textValue,
        sendText: textValue || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        createdAt,
        replyTo: quote,
        turn: {
          modelSelection: bot === null ? thread.modelSelection : botEffectiveModelSelection(bot),
          titleSeed: titleSeedFor(textValue, snapshot),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          followUp,
        },
        attachments: snapshot.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      });
      if (entry === null) {
        setNotice(
          plainNotice("Couldn't save that message on this device. Your draft is still here."),
        );
        return false;
      }
      return true;
    } catch (cause) {
      console.warn("outbox queue failed", cause);
      setNotice(plainNotice("Couldn't queue that message. Your draft is still here."));
      return false;
    }
  };

  const choiceSendingRef = useRef(false);

  const writeStored = (next: string | null): boolean => {
    try {
      const kv = native.client.ports.kv;
      if (next === null) {
        kv.removeItem(outgoingKey);
        const index = forgetOutgoingKey(kv.getItem(OUTGOING_INDEX_KEY), outgoingKey);
        if (index === null) kv.removeItem(OUTGOING_INDEX_KEY);
        else kv.setItem(OUTGOING_INDEX_KEY, index);
      } else {
        kv.setItem(outgoingKey, next);
        kv.setItem(
          OUTGOING_INDEX_KEY,
          rememberOutgoingKey(kv.getItem(OUTGOING_INDEX_KEY), outgoingKey),
        );
      }
      return true;
    } catch {
      return false;
    }
  };

  const dropStored = (messageId: string) => {
    writeStored(removeStoredOutgoing(native.client.ports.kv.getItem(outgoingKey), messageId));
  };

  const keepStored = (outgoing: Outgoing, meta: SendMeta): boolean =>
    writeStored(addStoredOutgoing(native.client.ports.kv.getItem(outgoingKey), outgoing, meta));

  const restoreIntoComposer = (outgoing: Outgoing) => {
    const next = restoreDraft(outgoing, draftRef.current);
    setDraft(next);
    if (next.text.length === 0) native.client.ports.kv.removeItem(key);
    else native.client.ports.kv.setItem(key, next.text);
  };

  /**
   * The server has the message: its saved copy goes and its photo keeps drawing. The pending
   * bubble stays until the transcript shows the message, so no frame is left without a bubble.
   */
  const landed = (messageId: string, snapshot: ReadonlyArray<DraftAttachment>) => {
    if (!activeSends.current.has(messageId)) return;
    activeSends.current.delete(messageId);
    dropStored(messageId);
    // A sent image is drawn from its device file until the server's copy draws.
    localImages.landed(messageId, () => {
      discardClaimedIntakes(messageId);
      releaseDraftCopies(snapshot);
    });
    void discardOutgoingFiles(messageId);
    onSent();
  };

  /** A send nobody answered: the bubble stays, with the text and Try again. */
  const markFailed = (outgoing: Outgoing) => {
    const active = activeSends.current.get(outgoing.id);
    if (active === undefined) return;
    const failed = settle(outgoing, { ok: false });
    activeSends.current.set(outgoing.id, { ...active, outgoing: failed });
    onPendingChange((pending) => setPendingState(pending, outgoing.id, "failed"));
    if (!keepStored(failed, active.meta)) {
      setNotice(
        plainNotice("Couldn't keep this message on the device. Try again before leaving the chat."),
      );
    }
  };

  const dropActive = (outgoing: Outgoing) => {
    activeSends.current.delete(outgoing.id);
    onPendingChange((pending) => removePending(pending, outgoing.id));
    dropStored(outgoing.id);
  };

  const queueForLater = async (outgoing: Outgoing, meta: SendMeta): Promise<boolean> =>
    await queue(
      outgoing.id,
      outgoing.text,
      outgoing.createdAt,
      meta.followUp ?? null,
      outgoing.attachments,
      meta.quote,
    );

  /**
   * Sends one active message. A resolution, a refusal, a dropped socket and a
   * server that never answers all end here; only a success drops the bubble.
   */
  const dispatch = async (messageId: string): Promise<boolean> => {
    const active = activeSends.current.get(messageId);
    if (active === undefined) return true;
    const { outgoing, meta } = active;
    const snapshot = outgoing.attachments;
    const abort = new AbortController();
    sendAborts.current.set(messageId, abort);
    let uploaded: ReadonlyArray<ChatAttachment> = [];
    if (snapshot.length > 0) {
      setPreparing(true);
      try {
        const readable = await readableOutgoingFiles(messageId, snapshot);
        if (readable === null) {
          sendAborts.current.delete(messageId);
          markFailed(outgoing);
          setNotice(plainNotice("An attachment didn't upload. Try again."));
          return false;
        }
        uploaded = (await uploadDraftAttachments(native, chat, readable)) ?? [];
      } finally {
        setPreparing(false);
      }
      if (uploaded.length !== snapshot.length) {
        sendAborts.current.delete(messageId);
        markFailed(outgoing);
        setNotice(plainNotice("An attachment didn't upload. Try again."));
        return false;
      }
      localImages.hold(
        messageId,
        snapshot.flatMap((attachment, index) =>
          attachment.kind === "image" ? [{ index, uri: attachment.uri }] : [],
        ),
      );
    }
    if (abort.signal.aborted) {
      sendAborts.current.delete(messageId);
      return false;
    }
    const turn = {
      modelSelection: bot === null ? thread.modelSelection : botEffectiveModelSelection(bot),
      titleSeed: titleSeedFor(outgoing.text, snapshot),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      followUp: meta.followUp ?? null,
    };
    const context = withPersonalFollowUp(
      meta.quote !== null ? personalReplyContext(meta.quote) : null,
      meta.followUp,
    );
    const attempt = startTurn({
      environmentId: native.environmentId,
      input: {
        commandId: CommandId.make(outboxCommandId(messageId)),
        threadId: ThreadId.make(threadId),
        message: {
          messageId: MessageId.make(messageId),
          role: "user",
          text: outgoing.text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          attachments: uploaded,
          ...(context !== null ? { context } : {}),
        },
        modelSelection: turn.modelSelection,
        titleSeed: turn.titleSeed,
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
        ...(meta.followUp !== undefined ? { followUp: meta.followUp } : {}),
        ...(meta.followUp === "queue" ? { dispatchMode: "queue" as const } : {}),
        createdAt: outgoing.createdAt,
      },
    });
    // The reply may arrive after the deadline: the message landed, so the
    // failed bubble goes instead of doubling the transcript.
    void attempt.then(
      (result) => {
        if (result._tag === "Success") landed(messageId, snapshot);
      },
      () => undefined,
    );
    const generation = native.readConnection().generation;
    const end = await awaitAck(
      attempt,
      (result): AckEnd => {
        if (result._tag === "Success") return { kind: "sent" };
        const outcome = classifySendFailure(squashAtomCommandFailure(result));
        if (outcome.kind === "rejected") return { kind: "rejected", message: outcome.message };
        if (outcome.kind === "not-sent") return { kind: "not-sent" };
        return { kind: "unknown" };
      },
      () => {
        const current = native.readConnection();
        return !current.connected || current.generation !== generation;
      },
      abort.signal,
    );
    if (sendAborts.current.get(messageId) === abort) sendAborts.current.delete(messageId);
    if (!activeSends.current.has(messageId)) return true;
    switch (end.kind) {
      case "sent":
        landed(messageId, snapshot);
        return true;
      case "rejected": {
        const failed = settle(outgoing, { ok: false });
        dropActive(failed);
        localImages.drop(messageId);
        if (meta.clearDraftAfter) {
          reholdClaimedIntakes(messageId);
          restoreIntoComposer(failed);
        } else {
          discardClaimedIntakes(messageId);
        }
        void discardOutgoingFiles(messageId);
        setNotice(plainNotice(end.message));
        return false;
      }
      case "not-sent": {
        dropActive(outgoing);
        localImages.drop(messageId);
        const queued = await queueForLater(outgoing, meta);
        if (!queued) {
          reholdClaimedIntakes(messageId);
          if (meta.clearDraftAfter) restoreIntoComposer(outgoing);
          void discardOutgoingFiles(messageId);
          return false;
        }
        discardClaimedIntakes(messageId);
        onSent();
        return true;
      }
      case "timeout":
      case "disconnected":
      case "unknown":
        markFailed(outgoing);
        return false;
      case "cancelled":
        return false;
    }
  };

  const submit = async ({
    textValue,
    snapshot,
    followUp,
    quote,
    clearDraftAfter,
  }: {
    readonly textValue: string;
    readonly snapshot: ReadonlyArray<DraftAttachment>;
    readonly followUp: ThreadTurnFollowUp | undefined;
    readonly quote: PersonalReplyQuote | null;
    readonly clearDraftAfter: boolean;
  }): Promise<boolean> => {
    const messageId = newOutboxId();
    const createdAt = new Date().toISOString();
    setNotice(null);
    onSendError(null);
    const { draft: clearedDraft, outgoing } = beginSend(
      { text: textValue, attachments: snapshot },
      messageId,
      createdAt,
    );
    const meta: SendMeta = { followUp, quote, clearDraftAfter };
    claimIntakes(messageId, snapshot);
    if (clearDraftAfter) {
      setDraft(clearedDraft);
      native.client.ports.kv.removeItem(key);
      onClearReply();
    }
    activeSends.current.set(messageId, { outgoing, meta });
    onPendingChange((pending) => [
      ...pending,
      pendingSend(outgoing, threadId, textValue || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
    ]);
    if (!keepStored(outgoing, meta)) {
      setNotice(
        plainNotice(
          "Couldn't save that message on the device. Don't leave the chat until it sends.",
        ),
      );
    }
    if (snapshot.length > 0) {
      setPreparing(true);
      let retained = false;
      try {
        retained = await retainOutgoingFiles(messageId, snapshot);
      } finally {
        setPreparing(false);
      }
      if (!retained) {
        activeSends.current.delete(messageId);
        onPendingChange((pending) => removePending(pending, messageId));
        dropStored(messageId);
        reholdClaimedIntakes(messageId);
        if (clearDraftAfter) restoreIntoComposer(outgoing);
        void discardOutgoingFiles(messageId);
        setNotice(
          plainNotice("Couldn't save those photos on this device. Your draft is still here."),
        );
        return false;
      }
    }
    if (offline || hasOutboxForThread(threadId)) {
      activeSends.current.delete(messageId);
      onPendingChange((pending) => removePending(pending, messageId));
      dropStored(messageId);
      const queued = await queueForLater(outgoing, meta);
      if (!queued) {
        reholdClaimedIntakes(messageId);
        if (clearDraftAfter) restoreIntoComposer(outgoing);
        void discardOutgoingFiles(messageId);
        return false;
      }
      discardClaimedIntakes(messageId);
      onSent();
      return true;
    }
    return await dispatch(messageId);
  };

  const retry = async (messageId: string): Promise<boolean> => {
    const active = activeSends.current.get(messageId);
    if (active === undefined) return false;
    activeSends.current.set(messageId, { ...active, outgoing: retrySend(active.outgoing) });
    onPendingChange((pending) => setPendingState(pending, messageId, "sending"));
    setNotice(null);
    return await dispatch(messageId);
  };

  const forget = (messageId: string) => {
    const active = activeSends.current.get(messageId);
    activeSends.current.delete(messageId);
    onPendingChange((pending) => removePending(pending, messageId));
    dropStored(messageId);
    if (active !== undefined) {
      localImages.landed(messageId, () => {
        discardClaimedIntakes(messageId);
        releaseDraftCopies(active.outgoing.attachments);
      });
      void discardOutgoingFiles(messageId);
      onSent();
    }
  };

  const send = async (followUp?: ThreadTurnFollowUp) => {
    const current = draftRef.current;
    if (!hasDraftContent(current) || preparing) return;
    await submit({
      textValue: current.text.trim(),
      snapshot: current.attachments,
      followUp,
      quote: replyTo,
      clearDraftAfter: true,
    });
  };

  const sendChoice = async (option: string): Promise<boolean> => {
    if (choiceSendingRef.current || preparing) return false;
    choiceSendingRef.current = true;
    try {
      return await submit({
        textValue: option,
        snapshot: [],
        followUp: undefined,
        quote: null,
        clearDraftAfter: false,
      });
    } finally {
      choiceSendingRef.current = false;
    }
  };

  useEffect(() => {
    if (control === undefined) return;
    // eslint-disable-next-line react/immutability -- the chat screen owns this ref for choice sends
    control.current = { sendText: sendChoice, retry, forget };
    return () => {
      if (control.current?.sendText === sendChoice) control.current = null;
    };
  });

  const stop = async () => {
    await onInterrupt();
  };

  const attachmentCount = attachments.length;
  const placeholder = botName.length > 0 ? `Message ${botName}…` : "Message…";

  return (
    <View style={styles.root}>
      <PrewarmAttachmentImages photos={photosToWarm(attachments)} />
      {notice !== null ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Pressable onPress={() => setNotice(null)} style={styles.errorBody}>
            <Text style={styles.errorText}>{notice.message}</Text>
          </Pressable>
          {notice.openSettings ? (
            <Pressable
              onPress={() => {
                setNotice(null);
                void Linking.openSettings();
              }}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.errorAction}>Open settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {replyTo !== null ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBody}>
            <Text style={styles.replyName} numberOfLines={1}>
              {replyTo.name}
            </Text>
            <Text style={styles.replyExcerpt} numberOfLines={1}>
              {replyTo.excerpt}
            </Text>
          </View>
          <Pressable
            onPress={onClearReply}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            style={styles.replyClose}
          >
            <IconX size={18} color={tokens.textSecondary} strokeWidth={2} />
          </Pressable>
        </View>
      ) : null}
      {attachments.length > 0 ? (
        <View style={styles.tray}>
          {attachments.map((attachment, index) => (
            <View key={attachment.id} style={styles.thumb}>
              <Pressable
                onPress={() => setPreviewAttachment(attachment)}
                accessibilityRole="button"
                accessibilityLabel={`Preview ${attachment.name}`}
                style={styles.thumbBody}
              >
                {attachment.kind === "image" ? (
                  <Image source={{ uri: attachment.uri }} style={styles.thumbImage} />
                ) : (
                  <IconFile size={20} color={tokens.textSecondary} strokeWidth={1.75} />
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  discardCameraDraft(attachment.uri);
                  setDraft((current) => ({
                    ...current,
                    attachments: current.attachments.filter((item) => item.id !== attachment.id),
                  }));
                }}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name}, ${index + 1} of ${attachmentCount}`}
                style={styles.thumbRemove}
              >
                <IconX size={12} color={tokens.text} strokeWidth={2.5} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={() => setAttachOpen(true)}
          disabled={picking || preparing}
          accessibilityRole="button"
          accessibilityLabel="Add photos"
          testID="composer-plus"
          style={styles.roundButton}
        >
          <IconPlus size={22} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
        <View style={styles.fieldBox}>
          <ComposerHost
            style={styles.fieldHost}
            onEnterSend={() => void send()}
            onContent={addKeyboardImages}
          >
            <TextInput
              value={text}
              onChangeText={(value) => setDraft((current) => ({ ...current, text: value }))}
              placeholder={placeholder}
              placeholderTextColor={tokens.textSecondary}
              accessibilityLabel={placeholder}
              multiline
              maxFontSizeMultiplier={1.6}
              style={[styles.field, styles.fieldInHost]}
            />
          </ComposerHost>
          <Pressable
            onPress={() => void pickFiles()}
            disabled={picking || preparing}
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            hitSlop={4}
            style={styles.fieldIconButton}
          >
            <IconPaperclip size={19} color={tokens.textSecondary} strokeWidth={1.75} />
          </Pressable>
        </View>
        {showStop ? (
          <Pressable
            onPress={() => void stop()}
            accessibilityRole="button"
            accessibilityLabel="Stop"
            style={[styles.sendButton, styles.stopButton]}
          >
            <IconSquare
              size={18}
              color={tokens.primaryText}
              strokeWidth={0}
              fill={tokens.primaryText}
            />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void send()}
            onLongPress={() => {
              if (canSend && working && supportsActiveSteering) setSendMenuOpen(true);
            }}
            delayLongPress={350}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={
              offline
                ? "Send, waits here until your laptop reconnects"
                : working && !supportsActiveSteering
                  ? "Send, queues until this turn ends"
                  : "Send"
            }
            style={[styles.sendButton, !canSend ? styles.disabled : null]}
          >
            <IconArrowUp size={21} color={tokens.primaryText} strokeWidth={2.5} />
          </Pressable>
        )}
      </View>
      {offline ? (
        <Text style={styles.offline}>
          Offline. Your draft is saved and sends when the laptop is back.
        </Text>
      ) : working && !supportsActiveSteering && hasContent ? (
        <Text style={styles.offline}>Queued until this turn ends.</Text>
      ) : null}
      <SheetShell
        visible={previewAttachment !== null}
        title={previewAttachment?.name ?? "Attachment"}
        onClose={() => setPreviewAttachment(null)}
      >
        {previewAttachment?.kind === "image" ? (
          <Image
            source={{ uri: previewAttachment.uri }}
            style={styles.previewImage}
            resizeMode="contain"
            accessibilityLabel={previewAttachment.name}
          />
        ) : (
          <Text style={styles.previewFile}>{previewAttachment?.name ?? ""}</Text>
        )}
      </SheetShell>
      <AttachSheet
        visible={attachOpen}
        photos={attachPhotos({
          embedded,
          attached: attachmentCount,
          maxAttachments: MAX_ATTACHMENTS,
        })}
        onClose={() => setAttachOpen(false)}
        onCamera={() => {
          setAttachOpen(false);
          void pickCamera();
        }}
        onAllPhotos={() => {
          setAttachOpen(false);
          void pickPhotos();
        }}
        onPicked={(intakeId) => {
          setAttachOpen(false);
          addKeyboardImages(intakeId);
        }}
        onUnavailable={() => setEmbedded(false)}
      />
      <CameraCaptureSheet
        visible={capture !== null}
        reason={capture?.reason ?? null}
        onClose={() => setCapture(null)}
        onPhoto={async (photo) => {
          setCapture(null);
          await addCameraAsset(photo, "in-app");
        }}
      />
      <SheetShell visible={sendMenuOpen} title="Send" onClose={() => setSendMenuOpen(false)}>
        <SheetAction
          label="Send now"
          onPress={() => {
            setSendMenuOpen(false);
            void send();
          }}
        />
        <SheetAction
          label="Queue after this turn"
          onPress={() => {
            setSendMenuOpen(false);
            void send("queue");
          }}
        />
        <SheetCancel onPress={() => setSendMenuOpen(false)} />
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  fieldBox: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    borderRadius: 22,
    backgroundColor: tokens.fillMuted,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    paddingRight: 4,
  },
  fieldHost: { flex: 1 },
  fieldInHost: { flex: 0, alignSelf: "stretch" },
  field: { flex: 1, color: tokens.text, fontSize: 16, lineHeight: 22, paddingVertical: 10 },
  fieldIconButton: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  stopButton: { backgroundColor: tokens.primary },
  disabled: { opacity: 0.35 },
  error: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    padding: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  errorBody: { flex: 1 },
  errorText: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  errorAction: { color: tokens.text, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    backgroundColor: tokens.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replyBody: { flex: 1, borderLeftWidth: 2, borderLeftColor: tokens.borderStrong, paddingLeft: 8 },
  replyName: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  replyExcerpt: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  replyClose: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  tray: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbBody: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  thumbImage: { width: "100%", height: "100%" },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  offline: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, paddingBottom: 4 },
  previewImage: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
  previewFile: { color: tokens.text, fontSize: 15, paddingVertical: 24, textAlign: "center" },
});
