"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType, MutableRefObject } from "react";

import { getOverlayBack } from "~/lib/overlayBack";

interface OverlayActions {
  close(): void;
}

interface BackClosingProps {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: unknown) => void) | undefined;
  actionsRef?: MutableRefObject<OverlayActions | null> | undefined;
}

/**
 * Wraps a Base UI overlay root (dialog, alert dialog, menu, popover) so that,
 * where Back is a history step (Android), Back closes it while it is open
 * (lib/overlayBack.ts). Elsewhere it renders the root unchanged and adds no
 * history entry. The root's own props, types and behaviour are untouched.
 */
export function withBackClose<Root>(Primitive: Root): Root {
  const Inner = Primitive as unknown as ComponentType<BackClosingProps>;

  function BackClosingRoot(props: BackClosingProps) {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
    const ownActions = useRef<OverlayActions | null>(null);
    const actions = props.actionsRef ?? ownActions;
    const open = props.open ?? uncontrolledOpen;
    const { onOpenChange } = props;

    useEffect(() => {
      const overlayBack = getOverlayBack();
      if (!open || overlayBack === null) return;
      return overlayBack.register(() => actions.current?.close());
    }, [open, actions]);

    return (
      <Inner
        {...props}
        actionsRef={actions}
        onOpenChange={(next, details) => {
          setUncontrolledOpen(next);
          onOpenChange?.(next, details);
        }}
      />
    );
  }

  return BackClosingRoot as unknown as Root;
}
