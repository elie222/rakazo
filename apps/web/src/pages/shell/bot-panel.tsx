import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";

function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Computer</Trans>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            pressed={value === mode}
            onPressedChange={(pressed) => {
              if (pressed) onChange(mode);
            }}
            className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

export function CreateBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New bot</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Cancel new bot`} onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="create-bot-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Describe what this bot does`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={4}
          className="mt-2"
        />
      </label>
      <ComputerModePicker value={computerMode} onChange={setComputerMode} />
      <Button
        className="mt-5"
        disabled={!name.trim() || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
      </Button>
    </div>
  );
}

export function BotSettings({
  bot,
  memoryProviderConfigured,
  onSave,
  onExport,
  onClear,
}: {
  bot: Bot;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
    void Promise.all([rpc.models.credentials(), rpc.models.list(), rpc.me()])
      .then(([nextCredentials, nextCatalog, nextMe]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setMe(nextMe);
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch(() => undefined);
  }, []);

  const connectedOptions: Array<{
    key: string;
    provider: string;
    modelId: string;
    label: string;
  }> = [];
  const seenOptions = new Set<string>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const credentialInCatalog = Boolean(
      credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
    );
    // Catalog providers expand to every model for that connection. Free-form
    // credentials (model id not in the catalog) stay a single connected pair.
    const options =
      credential.modelId && !credentialInCatalog
        ? [
            {
              key: modelOptionKey(credential.provider, credential.modelId),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(entry.provider, entry.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
          }));
    for (const option of options) {
      if (seenOptions.has(option.key)) continue;
      seenOptions.add(option.key);
      connectedOptions.push(option);
    }
  }

  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const thinkingOptions = (effectiveEntry?.thinkingLevels ?? []).filter((level) => level !== "off");

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center">
        <BotAvatar color={bot.color} identity={bot.id} size={64} status={bot.status} />
      </div>
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2"
        />
      </label>
      <details data-testid="bot-settings-advanced" className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <span className="text-muted-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
        </Suspense>
        <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
          <Trans>Model</Trans>
          <NativeSelect
            id={`${ids}-model`}
            className="mt-2 w-full"
            value={modelKey}
            onChange={(event) => {
              setModelKey(event.target.value);
              setThinkingLevel("");
            }}
          >
            <NativeSelectOption value="">
              {t`Space default`}
              {me?.defaultModel
                ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
                : ""}
            </NativeSelectOption>
            {modelKey && !connectedOptions.some((option) => option.key === modelKey) ? (
              <NativeSelectOption value={modelKey}>
                {parseModelOptionKey(modelKey)?.modelId ?? modelKey}
              </NativeSelectOption>
            ) : null}
            {connectedOptions.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {thinkingOptions.length ? (
          <label htmlFor={`${ids}-thinking`} className={fieldLabelClass}>
            <Trans>Thinking</Trans>
            <NativeSelect
              id={`${ids}-thinking`}
              className="mt-2 w-full"
              value={thinkingLevel}
              onChange={(event) => setThinkingLevel(event.target.value)}
            >
              <NativeSelectOption value="">{t`Default (medium)`}</NativeSelectOption>
              {thinkingOptions.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-muted-foreground">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
                ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
              ).map((option) => (
                <Toggle
                  key={option.label}
                  variant="outline"
                  size="sm"
                  pressed={memoryScope === option.value}
                  onPressedChange={(pressed) => {
                    if (pressed) setMemoryScope(option.value);
                  }}
                  className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
        ) : null}
        <label
          htmlFor={`${ids}-auto-speak`}
          className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-foreground/75"
        >
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label htmlFor={`${ids}-voice`} className={fieldLabelClass}>
            <Trans>Voice</Trans>
            <NativeSelect
              id={`${ids}-voice`}
              className="mt-2 w-full"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            const selected = modelKey ? parseModelOptionKey(modelKey) : null;
            const nextName = name.trim();
            const nextTitle = title.trim();
            const nextDescription = description.trim();
            setName(nextName);
            setTitle(nextTitle);
            setDescription(nextDescription);
            void onSave({
              name: nextName,
              title: nextTitle,
              description: nextDescription,
              instructions: nextDescription,
              computerMode,
              memoryScope,
              autoSpeak,
              voiceId: voiceId || null,
              modelProvider: selected?.provider ?? null,
              modelId: selected?.modelId ?? null,
              // Only clear thinking when catalog metadata is available; otherwise
              // preserve the stored override if models.list failed or is still loading.
              ...(modelMetaReady
                ? {
                    thinkingLevel: thinkingOptions.length
                      ? ((thinkingLevel || null) as ThinkingLevel | null)
                      : null,
                  }
                : {}),
            })
              .catch((err) => setError(err instanceof Error ? err.message : t`Could not save`))
              .finally(() => setSaving(false));
          }}
        >
          <Trans>Save</Trans>
        </Button>
        <Button variant="ghost" size="sm" className="-ms-2.5" onClick={() => void onExport()}>
          <Trans>Export</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 text-destructive hover:text-destructive"
          onClick={onClear}
        >
          <Trans>Clear conversation</Trans>
        </Button>
      </div>
    </div>
  );
}

function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") return t`Extra high`;
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  if (level === "minimal") return t`Minimal`;
  if (level === "max") return t`Max`;
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}
