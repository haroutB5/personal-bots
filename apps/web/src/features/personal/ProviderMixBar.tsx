import type { JSX } from "react";

import type { UsageProviderKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { providerColor, type TokenUsageMixSegment } from "./tokenUsagePresentation";

/**
 * A stacked bar of who the tokens belong to: one segment per provider, sized by
 * its tokens, in the card's fixed provider order. Decoration only (the numbers
 * are written beside it), so it is hidden from a screen reader. `widthPercent`
 * shortens the whole bar, which is how a bot row reads against the heaviest bot.
 */
export function ProviderMixBar({
  segments,
  heightClass,
  widthPercent = 100,
  testId,
}: {
  readonly segments: ReadonlyArray<TokenUsageMixSegment>;
  /** Tailwind height, `h-2.5` for the card's bar and `h-1.5` for a bot's. */
  readonly heightClass: string;
  readonly widthPercent?: number;
  readonly testId?: string;
}): JSX.Element {
  // A bar with no provider data is still a bar, in the folded-away grey.
  const drawn: ReadonlyArray<TokenUsageMixSegment> =
    segments.length > 0 ? segments : [{ provider: "cursor", tokens: 1 }];
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={cn("flex gap-[2px]", heightClass)}
      style={{ width: `${widthPercent}%` }}
    >
      {drawn.map((segment) => (
        <span
          key={segment.provider}
          data-provider={segment.provider}
          className="min-w-[3px] rounded-[3px]"
          style={{
            flex: `${segment.tokens} 0 0`,
            backgroundColor: providerColor(segment.provider),
          }}
        />
      ))}
    </span>
  );
}

/** The 8px dot that names a provider by colour. */
export function ProviderDot({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-provider={provider}
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: providerColor(provider) }}
    />
  );
}
