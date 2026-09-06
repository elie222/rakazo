import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  BOT_COLORS,
  BOT_INSTRUCTIONS_MAX_LENGTH,
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

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
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

function BotColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Color</Trans>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {BOT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Use ${color}`}
            aria-pressed={value.toLowerCase() === color.toLowerCase()}
            onClick={() => onChange(color)}
            className="h-8 w-8 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              backgroundColor: color,
              borderColor:
                value.toLowerCase() === color.toLowerCase() ? "currentColor" : "transparent",
            }}
          />
        ))}
        <label className="relative grid h-8 w-8 cursor-pointer place-items-center overflow-hidden rounded-full border-2 border-border">
          <span className="sr-only">
            <Trans>Custom color</Trans>
          </span>
          <input
            type="color"
            aria-label="Custom color"
            value={value}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="absolute h-12 w-12 cursor-pointer border-0 bg-transparent p-0"
          />
        </label>
        <span className="font-mono text-[12px] uppercase text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}

function BotSectionPicker({
  sections,
  value,
  onChange,
}: {
  sections: BotSection[];
  value: string | null;
  onChange: (sectionId: string | null) => void;
}) {
  return (
    <label className="mt-4 block text-[14px] text-muted-foreground">
      <Trans>Section</Trans>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="mt-2 w-full rounded-[11px] border border-border bg-background px-3.5 py-3 text-foreground"
      >
        <option value="">
          <Trans>Unassigned</Trans>
        </option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function BotSkillsPicker({
  skills,
  value,
  onChange,
}: {
  skills: AgentSkillCatalogEntry[];
  value: string[] | null;
  onChange: (skillIds: string[]) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const selectedIds = value ?? [];
  const selected = new Set(selectedIds);
  const visibleSkills = skills.filter((skill) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle)
    );
  });

  function toggle(skillId: string) {
    const next = new Set(selectedIds);
    if (next.has(skillId)) next.delete(skillId);
    else next.add(skillId);
    onChange(skills.map((skill) => skill.id).filter((id) => next.has(id)));
  }

  return (
    <div className="mt-4 text-[14px] text-muted-foreground">
      <Trans>Skills</Trans>
      <details className="relative mt-2" data-testid="bot-skills-picker">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-[11px] border border-border bg-background px-3.5 py-3 text-foreground">
          <span>
            {skills.length === 0
              ? t`No installed skills`
              : t`${selected.size} of ${skills.length} attached`}
          </span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="absolute left-0 right-0 z-30 mt-2 rounded-[13px] border border-border bg-popover p-3 shadow-[0_18px_50px_rgba(0,0,0,.65)]">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search skills`}
              aria-label={t`Search skills`}
              className="min-w-0 flex-1 rounded-[9px] border border-border bg-background px-3 py-2 text-foreground"
            />
            <button
              type="button"
              onClick={() => onChange(skills.map((skill) => skill.id))}
              className="rounded-[9px] border border-border px-2.5 text-[12px] text-foreground/75"
            >
              <Trans>Select all</Trans>
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="rounded-[9px] border border-border px-2.5 text-[12px] text-foreground/75"
            >
              <Trans>Clear all</Trans>
            </button>
          </div>
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {visibleSkills.map((skill) => (
              <label
                key={skill.id}
                className="flex cursor-pointer gap-3 rounded-[10px] border border-border bg-background p-3"
              >
                <input
                  type="checkbox"
                  checked={selected.has(skill.id)}
                  onChange={() => toggle(skill.id)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    {skill.name}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {skill.source}
                    </span>
                  </span>
                  <span className="mt-1 block text-[12px] leading-5 text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
              </label>
            ))}
            {visibleSkills.length === 0 ? (
              <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">
                <Trans>No matching skills</Trans>
              </p>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}

export function CreateBotForm({
  sections,
  onCreate,
  onCancel,
}: {
  sections: BotSection[];
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
    sectionId: string | null;
    computerMode: ComputerMode;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string>(BOT_COLORS[0]);
  const [sectionId, setSectionId] = useState<string | null>(null);
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
        instructions: instructions.trim(),
        color,
        sectionId,
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
      <label htmlFor={`${ids}-instructions`} className={fieldLabelClass}>
        <Trans>Instructions</Trans>
        <Textarea
          id={`${ids}-instructions`}
          value={instructions}
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          onChange={(event) => setInstructions(event.target.value)}
          rows={8}
          className="mt-2"
        />
      </label>
      <BotColorPicker value={color} onChange={setColor} />
      <BotSectionPicker sections={sections} value={sectionId} onChange={setSectionId} />
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
  sections,
  agentSkills,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
}: {
  bot: Bot;
  sections: BotSection[];
  agentSkills: AgentSkillCatalogEntry[];
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    sectionId?: string | null;
    agentSkillIds?: string[] | null;
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
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [color, setColor] = useState(bot.color);
  const [sectionId, setSectionId] = useState(bot.sectionId);
  const [agentSkillIds, setAgentSkillIds] = useState<string[]>(bot.agentSkillIds ?? []);
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
  const effectiveCredential = credentials.find(
    (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
  );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center">
        <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
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
      <label htmlFor={`${ids}-instructions`} className={fieldLabelClass}>
        <Trans>Instructions</Trans>
        <Textarea
          id={`${ids}-instructions`}
          value={instructions}
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          onChange={(event) => setInstructions(event.target.value)}
          rows={8}
          className="mt-2"
        />
      </label>
      <BotColorPicker value={color} onChange={setColor} />
      <BotSectionPicker sections={sections} value={sectionId} onChange={setSectionId} />
      <BotSkillsPicker skills={agentSkills} value={agentSkillIds} onChange={setAgentSkillIds} />
      <details
        data-testid="bot-settings-advanced"
        className="group mt-5"
        onToggle={(event) => {
          if (event.currentTarget.open) setAdvancedOpened(true);
        }}
      >
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
          {advancedOpened ? (
            <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
          ) : null}
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
              instructions: instructions.trim(),
              color,
              sectionId,
              agentSkillIds,
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
