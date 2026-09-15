import type { FormEvent, JSX, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import {
  type BotAvatarShape,
  type EnvironmentId,
  type ModelSelection,
  type PersonalBot,
  PersonalBotId,
  type ServerProvider,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { randomUUID } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatarPicker } from "./BotAvatarPicker";
import {
  botEffortDescriptor,
  defaultModelFor,
  EFFORT_OPTION_IDS,
  modelOptionLabel,
} from "./botFormModel";
import { resolveBotProvider, providerLine } from "./botSummaries";
import { commandFailureMessage } from "./commandFeedback";
import { useDeleteBot } from "./useDeleteBot";
import {
  personalBotCreate,
  personalBotUpdate,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";

const FIELD_CLASS =
  "w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";
const NAME_MAX = 60;
const TITLE_MAX = 60;

function isSelectable(provider: ServerProvider): boolean {
  return resolveBotProvider(provider.instanceId, [provider]).available;
}

interface BotDraft {
  name: string;
  title: string;
  description: string;
  instructions: string;
  avatarShape: BotAvatarShape;
  avatarColor: string;
  instanceId: string;
  model: string;
  /** Reasoning effort option id; "" keeps the model's default. */
  effort: string;
}

function draftFromBot(bot: PersonalBot): BotDraft {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor,
    instanceId: bot.modelSelection.instanceId,
    model: bot.modelSelection.model,
    effort:
      EFFORT_OPTION_IDS.map((id) =>
        getModelSelectionStringOptionValue(bot.modelSelection, id),
      ).find((value) => value !== undefined) ?? "",
  };
}

function PersonalPageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex h-14 items-center gap-1">
      <Link
        to="/bots"
        aria-label="Back to Bots"
        className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-[19px] font-bold text-[var(--personal-text)]">
        {title}
      </h1>
      {children}
    </header>
  );
}

export { PersonalPageHeader };

/**
 * Create/edit form: name, description, instructions, provider instance and
 * model (from the server's discovered providers) and the avatar picker. The
 * create path uses a botId generated once per form, so a retried submit is
 * idempotent server-side.
 */
function BotForm({
  environmentId,
  bot,
}: {
  environmentId: EnvironmentId;
  bot: PersonalBot | null;
}): JSX.Element {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createBot = useAtomCommand(personalBotCreate);
  const updateBot = useAtomCommand(personalBotUpdate);
  const deleteBot = useDeleteBot(environmentId);
  const [botId] = useState(() => bot?.botId ?? PersonalBotId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const selectableProviders = useMemo(() => providers.filter(isSelectable), [providers]);
  const [rawDraft, setDraft] = useState<BotDraft>(() => {
    if (bot !== null) return draftFromBot(bot);
    const first =
      selectableProviders.find((provider) => provider.driver === "claudeAgent") ??
      selectableProviders[0];
    return {
      name: "",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      instanceId: first?.instanceId ?? "",
      model: defaultModelFor(first),
      effort: "",
    };
  });

  // A cold open of /bots/new renders before providers load; pick the first
  // ready one when it arrives so "Create bot" is not stuck disabled.
  // The owner runs bots on Claude Code first, so it is the default when ready.
  const firstSelectable =
    selectableProviders.find((provider) => provider.driver === "claudeAgent") ??
    selectableProviders[0];
  const draft: BotDraft =
    bot === null && rawDraft.instanceId === "" && firstSelectable !== undefined
      ? {
          ...rawDraft,
          instanceId: firstSelectable.instanceId,
          model: defaultModelFor(firstSelectable),
        }
      : rawDraft;

  // The bot's current instance stays listed even when it went unavailable, so
  // the select never silently shows a different provider than the saved one.
  const providerOptions = useMemo(() => {
    const options = [...selectableProviders];
    const current = providers.find((provider) => provider.instanceId === draft.instanceId);
    if (current !== undefined && !options.includes(current)) options.unshift(current);
    return options;
  }, [draft.instanceId, providers, selectableProviders]);
  const selectedProvider = providers.find((provider) => provider.instanceId === draft.instanceId);
  const providerStatus =
    draft.instanceId === "" ? null : resolveBotProvider(draft.instanceId, providers);
  const models = selectedProvider?.models ?? [];
  const canSave = draft.instanceId !== "" && draft.model !== "" && !busy;

  const update = (patch: Partial<BotDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    // The "give your bot a name" error clears as soon as the name is typed.
    if (patch.name !== undefined && patch.name.trim().length > 0) setNameError(null);
  };

  const effortDescriptor = botEffortDescriptor(selectedProvider, draft.model);
  // A saved effort the new model does not offer falls back to its default.
  const effortValue =
    effortDescriptor?.options.some((option) => option.id === draft.effort) === true
      ? draft.effort
      : "";

  const buildModelSelection = (): ModelSelection => {
    const unchanged =
      bot !== null &&
      bot.modelSelection.instanceId === draft.instanceId &&
      bot.modelSelection.model === draft.model;
    const base = unchanged
      ? bot.modelSelection
      : ({ instanceId: draft.instanceId, model: draft.model } as ModelSelection);
    const others = (base.options ?? []).filter((option) => !EFFORT_OPTION_IDS.includes(option.id));
    const options =
      effortDescriptor !== null && effortValue !== ""
        ? [...others, { id: effortDescriptor.id, value: effortValue }]
        : others;
    const { options: _previous, ...rest } = base;
    return (options.length > 0 ? { ...rest, options } : rest) as ModelSelection;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();
    if (name.length === 0) {
      setNameError("Give your bot a name.");
      // The form is taller than a phone screen: bring the field into view.
      const input = nameInputRef.current;
      input?.focus();
      input?.scrollIntoView({ block: "center" });
      return;
    }
    if (!canSave) return;
    setNameError(null);
    setSubmitError(null);
    setBusy(true);
    const fields = {
      name,
      title: draft.title.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
      avatarShape: draft.avatarShape,
      avatarColor: draft.avatarColor,
      modelSelection: buildModelSelection(),
    };
    const result =
      bot === null
        ? await createBot({ environmentId, input: { botId, ...fields } })
        : await updateBot({ environmentId, input: { botId, ...fields } });
    setBusy(false);
    if (result._tag === "Success") {
      await navigate({ to: "/bots" });
      return;
    }
    setSubmitError(commandFailureMessage(result, "The bot could not be saved."));
  };

  const onDelete = async () => {
    if (bot === null) return;
    setBusy(true);
    const outcome = await deleteBot(bot);
    setBusy(false);
    if (outcome.status === "cancelled") return;
    setSubmitError(outcome.status === "failed" ? outcome.message : null);
    if (outcome.status === "done") {
      await navigate({ to: "/bots" });
    }
  };

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-5 pb-8"
      noValidate
    >
      <div>
        <label htmlFor="bot-name" className={LABEL_CLASS}>
          Name
        </label>
        <input
          ref={nameInputRef}
          id="bot-name"
          value={draft.name}
          maxLength={NAME_MAX}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="Assistant"
          autoComplete="off"
          aria-invalid={nameError !== null}
          aria-describedby={nameError !== null ? "bot-name-error" : undefined}
          className={`${FIELD_CLASS} h-11`}
        />
        {nameError !== null ? (
          <p id="bot-name-error" role="alert" className="mt-1.5 text-sm text-[#b3261e]">
            {nameError}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="bot-title" className={LABEL_CLASS}>
          Title{" "}
          <span className="font-normal text-[var(--personal-text-secondary)]">(optional)</span>
        </label>
        <input
          id="bot-title"
          value={draft.title}
          maxLength={TITLE_MAX}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="Personal assistant"
          autoComplete="off"
          className={`${FIELD_CLASS} h-11`}
        />
      </div>

      <div>
        <label htmlFor="bot-description" className={LABEL_CLASS}>
          Description
        </label>
        <input
          id="bot-description"
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
          placeholder="What this bot is for"
          autoComplete="off"
          className={`${FIELD_CLASS} h-11`}
        />
      </div>

      <div>
        <label htmlFor="bot-instructions" className={LABEL_CLASS}>
          Instructions
        </label>
        <textarea
          id="bot-instructions"
          value={draft.instructions}
          onChange={(event) => update({ instructions: event.target.value })}
          rows={5}
          placeholder="How the bot should work and respond"
          className={`${FIELD_CLASS} min-h-[120px] resize-y py-2.5 leading-snug`}
        />
      </div>

      <div>
        <label htmlFor="bot-provider" className={LABEL_CLASS}>
          Provider
        </label>
        {providerOptions.length === 0 ? (
          <p className="text-[15px] text-[var(--personal-text-secondary)]">
            No provider is ready on your computer yet. Set up Claude Code or Codex there, then come
            back to create a bot.
          </p>
        ) : (
          <select
            id="bot-provider"
            value={draft.instanceId}
            onChange={(event) => {
              const next = providers.find((provider) => provider.instanceId === event.target.value);
              update({ instanceId: event.target.value, model: defaultModelFor(next) });
            }}
            className={`${FIELD_CLASS} h-11`}
          >
            {providerOptions.map((provider) => (
              <option key={provider.instanceId} value={provider.instanceId}>
                {providerLine(resolveBotProvider(provider.instanceId, providers))}
              </option>
            ))}
          </select>
        )}
        {providerStatus !== null && !providerStatus.available ? (
          <p className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
            {providerStatus.label} can't run right now, so this bot can't reply. Pick another
            provider or fix it on your computer.
          </p>
        ) : null}
      </div>

      {models.length > 0 ? (
        <div>
          <label htmlFor="bot-model" className={LABEL_CLASS}>
            Model
          </label>
          <select
            id="bot-model"
            value={draft.model}
            onChange={(event) => update({ model: event.target.value })}
            className={`${FIELD_CLASS} h-11`}
          >
            {models.some((model) => model.slug === draft.model) ? null : (
              <option value={draft.model}>{draft.model}</option>
            )}
            {models.map((model) => (
              <option key={model.slug} value={model.slug}>
                {modelOptionLabel(model)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {effortDescriptor !== null ? (
        <div>
          <label htmlFor="bot-effort" className={LABEL_CLASS}>
            Effort
          </label>
          <select
            id="bot-effort"
            value={effortValue}
            onChange={(event) => update({ effort: event.target.value })}
            className={`${FIELD_CLASS} h-11`}
          >
            <option value="">
              Default
              {(() => {
                const fallback = effortDescriptor.options.find((option) => option.isDefault);
                return fallback === undefined ? "" : ` (${fallback.label})`;
              })()}
            </option>
            {effortDescriptor.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-sm text-[var(--personal-text-secondary)]">
            Higher effort thinks longer and uses more of your plan's limits.
          </p>
        </div>
      ) : null}

      <fieldset className="rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
        <legend className="px-1 text-sm font-medium text-[var(--personal-text)]">Avatar</legend>
        <BotAvatarPicker
          shape={draft.avatarShape}
          color={draft.avatarColor}
          previewName={draft.name.trim()}
          onChange={(next) => update({ avatarShape: next.shape, avatarColor: next.color })}
        />
      </fieldset>

      {submitError !== null ? (
        <p role="alert" className="text-sm text-[#b3261e]">
          {submitError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSave}
        aria-busy={busy}
        className="h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 disabled:opacity-40"
      >
        {bot === null ? "Create bot" : "Save changes"}
      </button>

      {bot !== null ? (
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy}
          className="h-11 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[15px] font-medium text-[#b3261e] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          Delete bot
        </button>
      ) : null}
    </form>
  );
}

/** /bots/new */
export function NewBotScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  return (
    <div className="px-5">
      <PersonalPageHeader title="New bot" />
      {environmentId === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          Connect to your computer to create a bot.
        </p>
      ) : (
        <div className="mt-2">
          <BotForm environmentId={environmentId} bot={null} />
        </div>
      )}
    </div>
  );
}

/** /bots/$botId/edit */
export function EditBotScreen({ botId }: { botId: string }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  return (
    <div className="px-5">
      <PersonalPageHeader title={bot === null ? "Edit bot" : `Edit ${bot.name}`} />
      {environmentId !== null && bot !== null ? (
        <div className="mt-2">
          <BotForm key={bot.botId} environmentId={environmentId} bot={bot} />
        </div>
      ) : list.data !== null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          This bot no longer exists.{" "}
          <Link to="/bots" className="font-medium text-[var(--personal-text)] underline">
            Back to Bots
          </Link>
        </p>
      ) : null}
    </div>
  );
}
