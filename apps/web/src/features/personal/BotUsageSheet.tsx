import type { JSX } from "react";

import type { PersonalBot, PersonalBotTokenUsageWindowId } from "@t3tools/contracts";
import { MessageSquare, X } from "lucide-react";

import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { ProviderDot, ProviderMixBar } from "./ProviderMixBar";
import {
  cacheHitShare,
  formatBotMeta,
  formatCostCompact,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatWindowSpan,
  providerColor,
  shortProviderLabel,
  type TokenUsageModelView,
  type TokenUsageRowView,
  type TokenUsageTable,
} from "./tokenUsagePresentation";
import { UsageRangeControl } from "./UsageRangeControl";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const SECTION_LABEL = "text-[13px] leading-[18px] font-semibold text-[var(--personal-text)]";

/**
 * One bot's token use, every model in full. A bottom sheet over the Team card:
 * it draws from the table the card already built, so opening it fetches and
 * recomputes nothing. The range control is the card's own state, shared.
 */
export function BotUsageSheet({
  open,
  bot,
  row,
  table,
  windowId,
  onWindowChange,
  onClose,
  onOpenChat,
}: {
  readonly open: boolean;
  readonly bot: PersonalBot | null;
  readonly row: TokenUsageRowView | null;
  readonly table: TokenUsageTable | null;
  readonly windowId: PersonalBotTokenUsageWindowId;
  readonly onWindowChange: (id: PersonalBotTokenUsageWindowId) => void;
  /** Back, swipe, ×, scrim, drag-down and Esc all end here. */
  readonly onClose: () => void;
  readonly onOpenChat: (botId: string) => void;
}): JSX.Element {
  const shown = open && bot !== null && row !== null && table !== null;
  return (
    <Sheet open={shown} onOpenChange={(next) => !next && onClose()}>
      <SheetPopup
        side="bottom"
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-background/70 backdrop-blur-md"
        className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        {shown ? (
          <BotUsageSheetBody
            bot={bot}
            row={row}
            table={table}
            windowId={windowId}
            onWindowChange={onWindowChange}
            onOpenChat={onOpenChat}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}

function BotUsageSheetBody({
  bot,
  row,
  table,
  windowId,
  onWindowChange,
  onOpenChat,
}: {
  readonly bot: PersonalBot;
  readonly row: TokenUsageRowView;
  readonly table: TokenUsageTable;
  readonly windowId: PersonalBotTokenUsageWindowId;
  readonly onWindowChange: (id: PersonalBotTokenUsageWindowId) => void;
  readonly onOpenChat: (botId: string) => void;
}): JSX.Element {
  const span = formatWindowSpan(table.sinceDay, table.untilDay);
  const used = row.tokens > 0;
  return (
    <>
      <span
        aria-hidden="true"
        className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-[var(--personal-border-strong)]"
      />
      <div className="flex shrink-0 items-center gap-3 py-2 pr-3 pl-5">
        <span className="grid size-10 shrink-0 place-items-center">
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={32} label="" />
        </span>
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {bot.name}
          </SheetTitle>
          <SheetDescription className="text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
            Token use · {span}
          </SheetDescription>
        </div>
        <SheetClose aria-label="Close" className={ICON_BUTTON}>
          <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
        </SheetClose>
      </div>
      <div
        data-testid="bot-usage-body"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pt-1 pb-5"
      >
        <UsageRangeControl windowId={windowId} onChange={onWindowChange} />
        {used ? (
          <>
            <StatTiles row={row} />
            <p
              data-testid="bot-usage-meta"
              className="-mt-2 text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums"
            >
              {formatBotMeta(row)}
            </p>
            <ProvidersBlock row={row} />
            <TokenMixBlock row={row} />
            <ModelsBlock row={row} />
          </>
        ) : (
          <p
            data-testid="bot-usage-empty"
            className="py-1 text-[15px] leading-5 text-[var(--personal-text-secondary)]"
          >
            {bot.name} used no tokens {windowId === "today" ? "today" : "in this period"}.
          </p>
        )}
        <button
          type="button"
          onClick={() => onOpenChat(bot.botId)}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] leading-5 font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <MessageSquare aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
          <span className="truncate">Open {bot.name} chat</span>
        </button>
        <p className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">
          Estimates at list API prices, not money charged. Subscriptions are flat.
        </p>
      </div>
    </>
  );
}

function StatTiles({ row }: { readonly row: TokenUsageRowView }): JSX.Element {
  const cost = formatCostCompact(row.cost);
  const unpricedNote =
    row.cost.kind === "partial" && row.unpricedTokens > 0
      ? `${formatTokenCount(row.unpricedTokens)} not priced`
      : null;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="Tokens" value={formatTokenCount(row.tokens)} testId="bot-usage-tokens" />
      <Tile
        label="API estimate"
        value={cost === "" ? "n/a" : cost}
        note={unpricedNote}
        testId="bot-usage-cost"
      />
      <Tile
        label="Of all bots"
        value={formatShare(row.sharePercent)}
        note={row.rank === null ? null : `#${row.rank} this period`}
        testId="bot-usage-share"
      />
    </div>
  );
}

function Tile({
  label,
  value,
  note = null,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | null;
  readonly testId: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-[10px] bg-[var(--personal-fill-muted)] px-3 py-2.5">
      <span className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">{label}</span>
      <span
        data-testid={testId}
        className={cn(
          "font-bold tabular-nums text-[var(--personal-text)]",
          // "not priced" is the one word that has to fit a third of the sheet.
          value.length > 8 ? "text-[16px] leading-[26px]" : "text-[20px] leading-[26px]",
        )}
      >
        {value}
      </span>
      {note === null ? null : (
        <span className="text-[11px] leading-[14px] text-[var(--personal-text-secondary)] tabular-nums">
          {note}
        </span>
      )}
    </div>
  );
}

function ProvidersBlock({ row }: { readonly row: TokenUsageRowView }): JSX.Element {
  const only = row.mix.length === 1 ? row.mix[0]! : null;
  return (
    <section aria-label="Providers" className="flex flex-col gap-2">
      <h3 className={SECTION_LABEL}>Providers</h3>
      {only !== null ? (
        <p
          data-testid="bot-usage-single-provider"
          className="flex items-center gap-2 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
        >
          <ProviderDot provider={only.provider} />
          <span>
            All on{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {shortProviderLabel(only.provider)}
            </b>
          </span>
        </p>
      ) : (
        <>
          <ProviderMixBar segments={row.mix} heightClass="h-2.5" testId="bot-usage-mix-bar" />
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {row.mix.map((segment) => (
              <li key={segment.provider} className="flex items-center gap-1.5">
                <ProviderDot provider={segment.provider} />
                <span>{shortProviderLabel(segment.provider)}</span>
                <b className="font-semibold text-[var(--personal-text)] tabular-nums">
                  {formatShare((segment.tokens / row.tokens) * 100)}
                </b>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TokenMixBlock({ row }: { readonly row: TokenUsageRowView }): JSX.Element {
  const hit = cacheHitShare(row.split);
  return (
    <section aria-label="Token mix" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={SECTION_LABEL}>Token mix</h3>
        {hit === null ? null : (
          <span className="text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
            {hit}% from cache
          </span>
        )}
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <MixFigure label="New input" value={row.split.input} />
        <MixFigure label="Cached input" value={row.split.cached} />
        <MixFigure label="Output" value={row.split.output} />
      </dl>
    </section>
  );
}

function MixFigure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">{label}</dt>
      <dd className="text-[16px] leading-[22px] font-semibold text-[var(--personal-text)] tabular-nums">
        {formatTokenCount(value)}
      </dd>
    </div>
  );
}

function ModelsBlock({ row }: { readonly row: TokenUsageRowView }): JSX.Element {
  const single = row.models.length === 1;
  return (
    <section aria-label="Models" className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h3 className={SECTION_LABEL}>Models</h3>
        <span className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">
          tokens · estimate
        </span>
      </div>
      <ul className="flex flex-col">
        {row.models.map((model) => (
          <li
            key={`${model.provider}:${model.model}`}
            data-testid="bot-usage-model"
            data-provider={model.provider}
            className="border-t border-[var(--personal-border)] py-3 first:border-t-0"
          >
            <ModelRow model={model} showBar={!single} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModelRow({
  model,
  showBar,
}: {
  readonly model: TokenUsageModelView;
  readonly showBar: boolean;
}): JSX.Element {
  const cost = formatCostCompact(model.cost);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[8px_1fr_auto] items-start gap-x-2.5">
        <ProviderDot provider={model.provider} className="mt-1.5" />
        <div className="flex min-w-0 flex-col">
          {/* Wraps, never truncates: "Gemini 3.8 Flash Lite Preview" is read in full. */}
          <span
            data-testid="bot-usage-model-name"
            className="text-[15px] leading-5 font-semibold text-[var(--personal-text)] [overflow-wrap:anywhere]"
          >
            {model.model}
          </span>
          <span className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">
            {model.providerLabel}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[15px] leading-5 font-semibold text-[var(--personal-text)] tabular-nums">
            {formatTokenCount(model.tokens)}
          </span>
          {cost === "" ? null : (
            <span
              data-testid="bot-usage-model-cost"
              className={cn(
                "text-[12px] leading-4 tabular-nums",
                model.cost.kind === "unpriced"
                  ? "text-[var(--personal-text-tertiary)]"
                  : "text-[var(--personal-text-secondary)]",
              )}
            >
              {cost}
            </span>
          )}
        </div>
      </div>
      {showBar ? (
        <span className="ml-[18px] block h-1 overflow-hidden rounded-sm bg-[var(--personal-track)]">
          <span
            data-testid="bot-usage-model-bar"
            className="block h-full rounded-sm"
            style={{
              width: `${Math.max(1.5, Math.min(100, model.sharePercent))}%`,
              backgroundColor: providerColor(model.provider),
            }}
          />
        </span>
      ) : null}
      <p className="ml-[18px] text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums [overflow-wrap:anywhere]">
        {formatShare(model.sharePercent)} · {formatSplit(model.split)}
      </p>
    </div>
  );
}
