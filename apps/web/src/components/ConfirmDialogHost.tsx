import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "@tanstack/react-router";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { isPersonalPath } from "../features/personal/personalMode";
import { cn } from "../lib/utils";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  // The action restated at the point of commitment ("Delete bot"), not "Confirm".
  const confirmLabel = (state.status === "idle" ? undefined : state.confirmLabel) ?? "Confirm";
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);
  // The Bots app draws its confirms in its own tokens: left-aligned so the
  // question reads first and the consequence under it, and phone-sized buttons.
  const personal = useLocation({ select: (location) => isPersonalPath(location.pathname) });

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup
        className={cn(
          "max-w-lg",
          personal &&
            "personal-app border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]",
        )}
      >
        <AlertDialogHeader className={cn(personal && "text-left")}>
          <AlertDialogTitle
            className={cn(personal && "text-[18px] leading-snug text-[var(--personal-text)]")}
          >
            {copy.title}
          </AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription
              className={cn(
                "whitespace-pre-line",
                personal && "text-[15px] leading-snug text-[var(--personal-text-secondary)]",
              )}
            >
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter
          className={cn(personal && "border-[var(--personal-border)] bg-transparent")}
        >
          <AlertDialogClose
            render={
              <Button
                variant="outline"
                className={cn(personal && "max-sm:h-11 max-sm:text-[15px]")}
              />
            }
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            className={cn(personal && "max-sm:h-11 max-sm:text-[15px]")}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
