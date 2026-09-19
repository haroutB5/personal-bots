import type { JSX } from "react";

import { Check } from "lucide-react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import {
  BOT_AVATAR_SHAPE_LABELS,
  BOT_AVATAR_SHAPE_ORDER,
  BOT_AVATAR_SWATCHES,
  botAvatarNeedsHalo,
} from "./botAvatarShapes";

export interface BotAvatarSelection {
  shape: BotAvatarShape;
  color: string;
}

export interface BotAvatarPickerProps {
  shape: BotAvatarShape;
  color: string;
  onChange: (next: BotAvatarSelection) => void;
  previewName: string;
}

/**
 * Avatar picker: live 72px preview, 7 shape buttons and 12 colour swatches.
 * Every option is a native button (≥44px target, `aria-pressed`, visible
 * focus) so the picker is fully keyboard operable.
 */
export function BotAvatarPicker({
  shape,
  color,
  onChange,
  previewName,
}: BotAvatarPickerProps): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <BotAvatar shape={shape} color={color} size={72} label={`${previewName} preview`} />
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-[var(--personal-text)]">
            {previewName || "Your bot"}
          </p>
          <p className="text-sm text-[var(--personal-text-secondary)]">
            {BOT_AVATAR_SHAPE_LABELS[shape]}
          </p>
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--personal-text)]">Shape</legend>
        <div className="grid grid-cols-4 gap-2">
          {BOT_AVATAR_SHAPE_ORDER.map((option) => {
            const selected = option === shape;
            return (
              <button
                key={option}
                type="button"
                aria-label={`Shape ${BOT_AVATAR_SHAPE_LABELS[option]}`}
                aria-pressed={selected}
                onClick={() => onChange({ shape: option, color })}
                className={cn(
                  "flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[var(--personal-radius-button)] border bg-[var(--personal-surface)] p-1.5 outline-none transition-shadow",
                  selected
                    ? "border-transparent ring-2 ring-[var(--personal-text)] ring-offset-2 ring-offset-[var(--personal-bg)]"
                    : "border-[var(--personal-border-strong)] hover:border-[var(--personal-text-secondary)]",
                  "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]",
                )}
              >
                <BotAvatar shape={option} color={color} size={36} label="" />
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--personal-text)]">Colour</legend>
        <div className="grid grid-cols-6 gap-2">
          {BOT_AVATAR_SWATCHES.map((swatch) => {
            const selected = swatch.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Colour ${swatch}`}
                aria-pressed={selected}
                onClick={() => onChange({ shape, color: swatch })}
                className={cn(
                  "flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full outline-none transition-shadow",
                  "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]",
                  selected &&
                    "ring-2 ring-[var(--personal-text)] ring-offset-2 ring-offset-[var(--personal-bg)]",
                )}
              >
                {/*
                  Same rule as the avatar (`botAvatarNeedsHalo`): a swatch that
                  fails 3:1 against the dark card is not a pickable circle, it
                  is a hole. The ring is `--personal-avatar-halo`, which is
                  `transparent` in light, so the light grid is unchanged.
                */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full",
                    botAvatarNeedsHalo(swatch) &&
                      "shadow-[0_0_0_1.5px_var(--personal-avatar-halo)]",
                  )}
                  style={{ backgroundColor: swatch }}
                >
                  {selected && <Check className="size-4 text-white" strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
