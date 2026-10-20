import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ExternalLink, MessageSquare } from "lucide-react";

import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import { usePersonalBotsList, usePersonalEnvironmentId } from "../usePersonalBots";
import {
  BUILT_IN_CATALOG_FALLBACK,
  providerCatalogAdd,
  providerCatalogList,
} from "./catalogClient";
import { unsupportedReasonCopy } from "./catalogModel";
import type { ProviderCatalogEntry, ProviderCatalogListResult } from "./catalogTypes";
import { downloadLine, licenceLine } from "./providerFacts";
import {
  BUTTON_BIG,
  BUTTON_PRIMARY,
  CARD,
  ProviderNote,
  ProviderTile,
  SECTION_TITLE,
} from "./providerUi";
import { InstallConfirmSheet } from "./ProviderSheets";

/**
 * Catalogue Provider Page before install (SPEC §5.1, frames `detail`, `unsupported`).
 */
export function CatalogProviderPageScreen({
  catalogId,
  returnTarget,
}: {
  readonly catalogId: string;
  readonly returnTarget?: string | undefined;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const botsQuery = usePersonalBotsList(environmentId);
  const bots = botsQuery.data?.bots ?? [];
  const navigate = useNavigate();

  const heroRef = useRef<HTMLDivElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    const node = heroRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeroVisible(entry?.isIntersecting ?? true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const catalogQuery = useEnvironmentQuery(
    environmentId !== null ? providerCatalogList({ environmentId, input: {} }) : null,
  );

  const entry: ProviderCatalogEntry | undefined = useMemo(() => {
    const catalogData = catalogQuery.data as ProviderCatalogListResult | null | undefined;
    const fromServer = catalogData?.entries.find(
      (e: ProviderCatalogEntry) => e.catalogId === catalogId,
    );
    if (fromServer !== undefined) return fromServer;
    return BUILT_IN_CATALOG_FALLBACK.find((e) => e.catalogId === catalogId);
  }, [catalogQuery.data, catalogId]);

  // Check if an instance already exists for this catalogId
  const existingInstance = useMemo(() => {
    return providers.find((p) => {
      if (entry?.source === "builtIn") {
        return p.driver === catalogId.replace(/^builtin:/, "");
      }
      const cfg = (p as unknown as { config?: { catalogId?: string } }).config;
      return cfg?.catalogId === catalogId || p.instanceId === catalogId;
    });
  }, [providers, entry, catalogId]);

  // If already installed and added, redirect to provider instance page
  useEffect(() => {
    if (existingInstance !== undefined && existingInstance.installed) {
      void navigate({
        to: "/bots/settings/providers/$instanceId",
        params: { instanceId: existingInstance.instanceId },
        search: returnTarget ? { return: returnTarget } : {},
        replace: true,
      });
    }
  }, [existingInstance, navigate, returnTarget]);

  const addCommand = useAtomCommand(providerCatalogAdd, { reportFailure: false });
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, {
    reportFailure: false,
  });

  const onConfirmInstall = async () => {
    if (environmentId === null || entry === undefined) return;
    setBusy(true);
    setSheetError(null);

    let instanceId: ProviderInstanceId | undefined = existingInstance?.instanceId;

    if (instanceId === undefined) {
      if (entry.source === "builtIn") {
        instanceId = entry.catalogId.replace(/^builtin:/, "") as ProviderInstanceId;
      } else {
        const addRes = await addCommand({ environmentId, input: { catalogId } });
        const addFail = commandFailureMessage(addRes, `Couldn't add ${entry.name}.`);
        if (addFail !== null) {
          setSheetError(addFail);
          setBusy(false);
          return;
        }
        // Result gives instanceId
        const value = (addRes as { value?: { instanceId?: string } })?.value;
        instanceId = (value?.instanceId ?? catalogId) as ProviderInstanceId;
      }
    }

    // Start install
    const startRes = await startInstall({
      environmentId,
      input: { instanceId: instanceId as any },
    });
    const startFail = commandFailureMessage(startRes, `Couldn't start ${entry.name} install.`);
    if (startFail !== null) {
      setSheetError(startFail);
      setBusy(false);
      return;
    }

    setSheetOpen(false);
    setBusy(false);

    // Navigate to instance provider page with replace so Back returns to catalogue
    await navigate({
      to: "/bots/settings/providers/$instanceId",
      params: { instanceId: instanceId as any },
      search: {
        action: "install",
        ...(returnTarget ? { return: returnTarget } : {}),
      },
      replace: true,
    });
  };

  const backTarget =
    returnTarget === "botform"
      ? "/bots/settings/providers/add?return=botform"
      : "/bots/settings/providers/add";

  const backSearch = returnTarget ? { return: returnTarget } : {};

  if (entry === undefined) {
    return (
      <div className="flex flex-col px-5 pb-8">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-[var(--personal-bg)]">
          <Link
            to="/bots/settings/providers/add"
            search={backSearch}
            aria-label="Back to catalogue"
            className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-[19px] font-bold text-[var(--personal-text)]">
            Provider
          </h1>
        </header>
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          This provider was not found in the catalogue.
        </p>
      </div>
    );
  }

  const isSupported = entry.supported.ok;
  const unsupportedReason = !entry.supported.ok ? entry.supported.reason : null;
  const unsupportedCopy = unsupportedReason ? unsupportedReasonCopy(unsupportedReason) : null;

  const ctoBot = bots.find((b) => b.name.toLowerCase() === "cto");
  const ctoDraft = `Can we set up ${entry.name} as a provider on my laptop?`;
  const ctoLink = ctoBot
    ? `/bots/${ctoBot.botId}?draft=${encodeURIComponent(ctoDraft)}`
    : `/bots?draft=${encodeURIComponent(ctoDraft)}`;

  const licence = licenceLine({
    openSource: entry.openSource,
    licence: entry.license,
    publisher: entry.publisher,
    description: entry.description,
    cost: entry.cost,
    signIn: entry.signInLabel,
    from: entry.distribution?.label ?? null,
  });

  const details: ReadonlyArray<{ key: string; value: ReactNode }> = [
    { key: "Sign in", value: entry.signInLabel ?? "Shown after install" },
    ...(entry.version !== null ? [{ key: "Version", value: entry.version }] : []),
    { key: "Download", value: downloadLine(entry.downloadBytes) },
    ...(entry.distribution?.label != null
      ? [{ key: "From", value: entry.distribution.label }]
      : entry.source === "builtIn"
        ? [{ key: "From", value: "Built into hbots" }]
        : []),
    ...(licence !== null ? [{ key: "Licence", value: licence }] : []),
    ...(entry.website != null || entry.repository != null
      ? [
          {
            key: "Website",
            value: (
              <a
                href={entry.website ?? entry.repository ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[var(--personal-text)] underline underline-offset-2"
              >
                <span>Visit site</span>
                <ExternalLink className="size-3.5" />
              </a>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col px-5 pb-12" data-catalog-detail-page={catalogId}>
      {/* Header */}
      <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-[var(--personal-bg)]">
        <Link
          to="/bots/settings/providers/add"
          search={backSearch}
          aria-label="Back to catalogue"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1
          className={`min-w-0 flex-1 truncate text-[19px] font-bold text-[var(--personal-text)] ${
            !heroVisible ? "" : "sr-only"
          }`}
        >
          {entry.name}
        </h1>
      </header>

      {/* Hero (SPEC §5.1) */}
      <div ref={heroRef} className="flex items-center gap-4 pb-4">
        <ProviderTile
          driver={
            entry.source === "builtIn" ? (entry.catalogId.replace(/^builtin:/, "") as any) : null
          }
          label={entry.name}
          iconUrl={entry.iconUrl}
          size="hero"
        />
        <div className="min-w-0">
          <h2 className="text-2xl leading-7 font-bold text-[var(--personal-text)]">{entry.name}</h2>
          <p className="text-[14px] leading-4.75 text-[var(--personal-text-secondary)]">
            {entry.publisher} · {entry.openSource ? "Open source" : "Closed source"}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {/* Description */}
        <p className="-mt-1 text-[15px] leading-[21px] text-[var(--personal-text)]">
          {entry.description}
        </p>

        {/* What it costs card (SPEC §5.1) */}
        <section aria-labelledby="catalog-cost">
          <h3 id="catalog-cost" className={SECTION_TITLE}>
            What it costs
          </h3>
          <div className={`${CARD} px-4 py-3`}>
            {entry.cost.kind !== "unknown" ? (
              <>
                <p className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                  {entry.cost.label}
                </p>
                {entry.cost.detail !== null ? (
                  <p className="mt-0.5 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                    {entry.cost.detail}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-[14px] leading-5 text-[var(--personal-text-secondary)]">
                The ACP registry doesn&apos;t list a price. You&apos;ll see the sign-in choices
                after it&apos;s installed.
              </p>
            )}
          </div>
        </section>

        {/* Details card (SPEC §5.1) */}
        <section aria-labelledby="catalog-details">
          <h3 id="catalog-details" className={SECTION_TITLE}>
            Details
          </h3>
          <dl className={`${CARD} divide-y divide-[var(--personal-border)]`}>
            {details.map((detail) => (
              <div
                key={detail.key}
                className="flex min-h-12 items-center justify-between gap-4 px-4"
              >
                <dt className="shrink-0 text-[15px] text-[var(--personal-text-secondary)]">
                  {detail.key}
                </dt>
                <dd className="min-w-0 text-right text-[15px] break-words text-[var(--personal-text)]">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Action: Install or Unsupported (SPEC §5.1) */}
        {isSupported ? (
          <div className="sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-[var(--personal-bg)] via-[var(--personal-bg)] to-transparent pt-6">
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className={`${BUTTON_BIG} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
            >
              Install {entry.name}
            </button>
          </div>
        ) : unsupportedCopy !== null ? (
          /* Frame unsupported (SPEC §5.1 & §7) */
          <div data-unsupported-card>
            <ProviderNote
              tone="info"
              title={unsupportedCopy.title}
              actions={
                <Link to={ctoLink} className={`${BUTTON_PRIMARY} gap-1.5`}>
                  <MessageSquare className="size-4" />
                  {unsupportedCopy.buttonLabel}
                </Link>
              }
            >
              {unsupportedCopy.text}
            </ProviderNote>
          </div>
        ) : null}
      </div>

      {/* Confirmation sheet (SPEC §5.2) */}
      {sheetOpen ? (
        <InstallConfirmSheet
          driver={
            entry.source === "builtIn" ? (entry.catalogId.replace(/^builtin:/, "") as any) : null
          }
          label={entry.name}
          facts={{
            publisher: entry.publisher,
            openSource: entry.openSource,
            licence: entry.license,
            description: entry.description,
            cost: entry.cost,
            signIn: entry.signInLabel,
            from: entry.distribution?.label ?? "ACP registry",
          }}
          version={entry.version}
          totalBytes={entry.downloadBytes}
          builtIn={entry.source === "builtIn"}
          busy={busy}
          error={sheetError}
          onConfirm={() => void onConfirmInstall()}
          onCancel={() => {
            setSheetOpen(false);
            setSheetError(null);
          }}
        />
      ) : null}
    </div>
  );
}
