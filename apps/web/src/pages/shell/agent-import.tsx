import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentImportFile,
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSkipReason,
  AgentImportStatus,
  AgentImportWarning,
  Bot,
  ComputerMode,
} from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  AGENT_IMPORT_NOT_FOUND,
  AGENT_IMPORT_PROMPT,
  AgentImportArchiveError,
  agentImportSkillFiles,
  agentImportUpload,
  chooseAgentImportFiles,
  combineImportedInstructions,
  hasAgentImportSecrets,
  openAgentImportArchive,
} from "@rakazo/core";
import {
  Button,
  Checkbox,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ArrowLeft, ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { ComputerModePicker } from "./bot-panel";
import { useImportStatusText } from "./import-status";

/** Warnings the status label already says. */
const STATUS_WARNINGS: ReadonlySet<AgentImportWarning> = new Set([
  "needs_setup",
  "unsupported_command",
  "local_path",
]);

const panelStyle = { section: "mt-6", heading: "text-sm text-foreground" };
// Onboarding's step style: label rhythm, full-width groups (see SignupSurvey).
const pageStyle = { section: "mt-6 first:mt-0", heading: "text-sm font-medium text-foreground" };

/** Import an OpenClaw or Hermes folder, or another assistant's exported document, as a new bot. */
/** A chosen folder or opened backup: its paths, and its files read on demand. */
export type AgentImportSource = {
  paths: string[];
  read: (path: string) => Promise<string> | string;
  size: (path: string) => number | undefined;
};

/** What the form sends to create the bot. */
export type AgentImportCreateRequest = Parameters<typeof rpc.bots.importCreate>[0];

export function AgentImportForm({
  onBack,
  onCancel,
  onCreated,
  createBot = (input) => rpc.bots.importCreate(input),
  layout = "panel",
}: {
  onBack: () => void;
  onCancel: () => void;
  onCreated: (bot: Bot) => void;
  /** How the bot is created; onboarding wraps it so a first bot is only made once. */
  createBot?: (input: AgentImportCreateRequest) => Promise<Bot>;
  /** `page` renders as an onboarding step; `panel` as the shell's side panel. */
  layout?: "panel" | "page";
}) {
  const page = layout === "page";
  const { section: sectionClass, heading: headingClass } = page ? pageStyle : panelStyle;
  const [kind, setKind] = useState<"folder" | "document">("folder");
  const { t } = useLingui();
  const statusText = useImportStatusText();
  const ids = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<AgentImportFile[]>([]);
  // The chosen folder or backup, read on demand.
  const [source, setSource] = useState<AgentImportSource | null>(null);
  // Its files read so far, by upload path, with their path in the agent's home.
  const [folder, setFolder] = useState<{ path: string; home: string; content: string }[]>([]);
  const [hasSecretFiles, setHasSecretFiles] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  // One key per import, so a retried create returns the bot the first one made.
  const importKey = useRef<string | null>(null);
  // Names of the other files in each skill's folder; never their contents.
  const [skillFiles, setSkillFiles] = useState<Record<string, string[]>>({});
  const archiveInput = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<AgentImportPlan | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [destinations, setDestinations] = useState<Record<string, AgentImportMemoryDestination>>(
    {},
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [reply, setReply] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function failure(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : "";
    setError(message === AGENT_IMPORT_NOT_FOUND ? notFound() : errorText(err, fallback));
  }

  function notFound() {
    return t`No OpenClaw, Hermes or agent document found.`;
  }

  async function preview(
    next: AgentImportFile[],
    secrets = false,
    keepChoices = false,
    siblings = skillFiles,
  ) {
    setError(null);
    if (next.length === 0) {
      setError(notFound());
      return;
    }
    setBusy(true);
    try {
      const found = await rpc.bots.importPreview({
        files: next,
        includeSecrets: secrets,
        skillFiles: siblings,
      });
      setFiles(next);
      setIncludeSecrets(secrets);
      // Anything that runs or acts (skills, MCP servers, routines) starts unticked, as do
      // untouched defaults the source wrote: the user ticks each one they want.
      const flagged = [
        ...found.skills,
        ...found.mcpServers,
        ...found.routines,
        ...found.instructions.filter((item) => item.stock),
        ...found.memory.filter((item) => item.stock),
      ].map((item) => item.id);
      if (keepChoices && plan) {
        // Turning the API key opt-in on or off keeps every choice; only new items get defaults.
        const known = new Set(
          [
            ...plan.instructions,
            ...plan.memory,
            ...plan.skills,
            ...plan.mcpServers,
            ...plan.routines,
            ...plan.apiKeys,
            ...(plan.model ? [plan.model] : []),
          ].map((item) => item.id),
        );
        setUnchecked((current) => {
          const merged = new Set(current);
          for (const id of flagged) if (!known.has(id)) merged.add(id);
          return merged;
        });
      } else {
        setUnchecked(new Set(flagged));
        setDestinations({});
        setName(found.suggestedName);
        setDescription(found.suggestedDescription);
      }
      setPlan(found);
    } catch (err) {
      failure(err, t`Could not read these files`);
    } finally {
      setBusy(false);
    }
  }

  /** Why a folder or backup could not be used, as the alert shows it. */
  function readError(err: unknown) {
    if (err instanceof AgentImportArchiveError) {
      return err.reason === "too_large"
        ? t`These files are too large to import.`
        : t`This backup could not be read.`;
    }
    return t`Could not read these files`;
  }

  /**
   * Reads a folder or backup with the shared rule: sizes are checked first, bundled skills
   * and `.env`/`auth.json` are not read, and only the files an import uses leave the device.
   */
  async function loadSource(next: AgentImportSource) {
    setError(null);
    try {
      const chosen = await chooseAgentImportFiles(next.paths, next.read, {
        includeSecrets: false,
        size: next.size,
      });
      const siblings = agentImportSkillFiles(
        next.paths,
        new Map(chosen.entries.map((entry) => [entry.path, entry.home])),
      );
      setSource(next);
      setFolder(chosen.entries);
      setHasSecretFiles(chosen.hasSecretFiles);
      setSkillFiles(siblings);
      importKey.current = crypto.randomUUID();
      await preview(
        agentImportUpload(chosen.entries, { includeSecrets: false }),
        false,
        false,
        siblings,
      );
    } catch (err) {
      setError(readError(err));
    }
  }

  /** The opt-in reads `.env`/`auth.json` now, and sends only their allowlisted entries. */
  async function toggleSecrets(checked: boolean) {
    if (!source) return;
    try {
      const chosen = await chooseAgentImportFiles(source.paths, source.read, {
        includeSecrets: checked,
        size: source.size,
      });
      setFolder(chosen.entries);
      await preview(agentImportUpload(chosen.entries, { includeSecrets: checked }), checked, true);
    } catch (err) {
      setError(readError(err));
    }
  }

  async function pickFolder(list: FileList | null) {
    const byPath = new Map(
      [...(list ?? [])].map((file) => [file.webkitRelativePath || file.name, file]),
    );
    await loadSource({
      paths: [...byPath.keys()],
      read: (path) => byPath.get(path)!.text(),
      size: (path) => byPath.get(path)?.size,
    });
  }

  /** A backup is unpacked here, on this device, one file at a time. */
  async function pickArchive(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      if (file.size > AGENT_IMPORT_ARCHIVE_LIMITS.archiveBytes) {
        throw new AgentImportArchiveError("too_large");
      }
      const archive = openAgentImportArchive(new Uint8Array(await file.arrayBuffer()));
      await loadSource(archive);
    } catch (err) {
      setError(readError(err));
    }
  }

  const secretsAvailable =
    hasSecretFiles || folder.some(({ home, content }) => hasAgentImportSecrets(home, content));

  /** A pasted or chosen document: no folder, no secrets. */
  async function previewDocument(content: string) {
    setSource(null);
    setFolder([]);
    setHasSecretFiles(false);
    setSkillFiles({});
    importKey.current = crypto.randomUUID();
    await preview([{ path: "agent.md", content }], false, false, {});
  }

  async function pickDocument(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    try {
      await previewDocument(await file.text());
    } catch (err) {
      setError(readError(err));
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(AGENT_IMPORT_PROMPT);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const selectedInstructions = plan?.instructions.filter((item) => !unchecked.has(item.id)) ?? [];
  const chosen = <T extends { id: string }>(items: T[] | undefined) =>
    (items ?? []).filter((item) => !unchecked.has(item.id));
  const keyedProviders = new Set(chosen(plan?.apiKeys).map((key) => key.provider));
  // A model needs a connection now, or its provider's key in this import.
  const modelUsable =
    plan?.model?.status === "ready" ||
    (plan?.model?.status === "needs_key" && keyedProviders.has(plan.model.provider));
  const tooLong =
    combineImportedInstructions(selectedInstructions).length > BOT_INSTRUCTIONS_MAX_LENGTH;

  async function create() {
    if (!plan || !name.trim() || tooLong || busy) return;
    setError(null);
    setBusy(true);
    try {
      const bot = await createBot({
        importKey: importKey.current ?? undefined,
        files,
        includeSecrets,
        skillFiles,
        name: name.trim(),
        description: description.trim(),
        computerMode,
        selection: {
          instructions: selectedInstructions.map((item) => item.id),
          memory: plan.memory
            .filter((item) => !unchecked.has(item.id))
            .map((item) => ({ id: item.id, destination: destinations[item.id] ?? "bot" })),
          skills: chosen(plan.skills)
            .filter((item) => item.status.kind !== "unsupported")
            .map((item) => item.id),
          model: Boolean(plan.model && modelUsable && !unchecked.has(plan.model.id)),
          mcpServers: chosen(plan.mcpServers)
            .filter((item) => item.status.kind !== "unsupported")
            .map((item) => item.id),
          routines: chosen(plan.routines).map((item) => item.id),
          apiKeys: chosen(plan.apiKeys).map((item) => item.id),
        },
      });
      onCreated(bot);
    } catch (err) {
      failure(err, t`Could not create bot`);
      setBusy(false);
    }
  }

  function toggle(id: string, checked: boolean) {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Each title expands to the text that would be imported; the checkbox stays separate.
  const item = (
    id: string,
    title: string,
    content: string,
    extra?: ReactNode,
    description?: string,
    disabled = false,
  ) => (
    <li key={id} className="py-1">
      <Collapsible>
        <div className="flex min-h-9 items-center gap-3">
          <Checkbox
            aria-label={title}
            checked={!disabled && !unchecked.has(id)}
            disabled={disabled}
            onCheckedChange={(checked) => toggle(id, checked)}
          />
          <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-start text-[14px] text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="truncate" dir="auto">
              {title}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-aria-expanded:rotate-0 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          {extra}
        </div>
        <CollapsibleContent>
          <div className="ms-7 mt-1" data-testid="agent-import-content">
            {description ? (
              <p className="mb-1 text-[13px] text-muted-foreground" dir="auto">
                {description}
              </p>
            ) : null}
            <pre
              className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2 font-mono text-[12px] text-foreground"
              dir="auto"
            >
              {content}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );

  // An untouched file the source wrote for every new agent.
  const defaultNote = plan?.source === "hermes" ? t`Default from Hermes` : t`Default from OpenClaw`;
  const skipReason = (reason: AgentImportSkipReason) =>
    ({
      runtime: t`Not used by Rakazo`,
      invalid_skill: t`Not a valid skill`,
      builtin: t`Built-in`,
      unsupported: t`Not supported in Rakazo`,
      connected: t`Already connected`,
      invalid_file: t`Could not read these files`,
      default: defaultNote,
    })[reason];
  const warningText = (warning: AgentImportWarning) =>
    ({
      needs_setup: t`Needs setup Rakazo may not have`,
      bundled_files: t`Uses files that are not imported`,
      runs_code: t`Contains code to run`,
      unsupported_command: t`Not supported in Rakazo`,
      local_path: t`Uses paths on your computer`,
      dropped_settings: t`Some settings are not imported`,
      changed_schedule: t`Timing may differ`,
    })[warning];
  /**
   * Next to each skill, MCP server and routine: whether it works here (Ready, what it needs,
   * or not supported), then anything else worth reading first.
   */
  const statusNote = (status: AgentImportStatus, warnings: AgentImportWarning[]) => {
    const others = warnings.filter((warning) => !STATUS_WARNINGS.has(warning));
    return note(
      [statusText.status(status), ...others.map((warning) => warningText(warning))].join(" · "),
    );
  };
  const note = (text: string) => (
    <span className="shrink-0 text-[12.5px] text-muted-foreground">{text}</span>
  );

  return (
    <div data-testid="agent-import">
      {page ? (
        <h1 className="text-[32px] font-medium text-foreground">
          <Trans>Import an agent</Trans>
        </h1>
      ) : (
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Back`}
              onClick={() => (plan ? setPlan(null) : onBack())}
            >
              <ArrowLeft size={16} strokeWidth={1.8} />
            </Button>
            <span className="text-[13.5px] text-muted-foreground">
              <Trans>Import an agent</Trans>
            </span>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t`Cancel new bot`} onClick={onCancel}>
            <X size={16} strokeWidth={1.8} />
          </Button>
        </div>
      )}
      {error ? (
        <p
          role="alert"
          data-testid="agent-import-error"
          className={page ? "mt-3 text-sm text-destructive" : "mb-3 text-[13px] text-destructive"}
        >
          {error}
        </p>
      ) : null}
      {plan ? (
        <div data-testid="agent-import-preview" className={page ? "mt-8" : undefined}>
          {plan.instructions.length ? (
            <section className={sectionClass} data-testid="agent-import-instructions">
              <h3 className={headingClass}>
                <Trans>Instructions</Trans>
              </h3>
              <ul className="mt-2">
                {plan.instructions.map((entry) => {
                  const mentions = entry.mentions.join(", ");
                  return item(
                    entry.id,
                    entry.title,
                    entry.content,
                    entry.stock
                      ? note(defaultNote)
                      : mentions
                        ? note(t`Mentions OpenClaw features`)
                        : undefined,
                    mentions ? t`Mentions: ${mentions}` : undefined,
                  );
                })}
              </ul>
              {tooLong ? (
                <p role="alert" className="mt-2 text-[13px] text-destructive">
                  <Trans>Instructions are too long. Untick some files.</Trans>
                </p>
              ) : null}
            </section>
          ) : null}
          {plan.memory.length ? (
            <section className={sectionClass} data-testid="agent-import-memory">
              <h3 className={headingClass}>
                <Trans>Memory</Trans>
              </h3>
              <ul className="mt-2">
                {plan.memory.map((entry) => {
                  const { title, spacePath: savedAs } = entry;
                  const destination = destinations[entry.id] ?? "bot";
                  const renamed = destination === "space" && savedAs !== entry.path;
                  return item(
                    entry.id,
                    renamed ? t`${title}, saved as ${savedAs}` : title,
                    entry.content,
                    <>
                      {entry.stock ? note(defaultNote) : null}
                      <NativeSelect
                        size="sm"
                        aria-label={t`Memory for ${title}`}
                        value={destination}
                        disabled={unchecked.has(entry.id)}
                        onChange={(event) =>
                          setDestinations((current) => ({
                            ...current,
                            [entry.id]: event.target.value as AgentImportMemoryDestination,
                          }))
                        }
                      >
                        <NativeSelectOption value="bot">{t`This bot`}</NativeSelectOption>
                        <NativeSelectOption value="space">{t`All bots`}</NativeSelectOption>
                      </NativeSelect>
                    </>,
                  );
                })}
              </ul>
            </section>
          ) : null}
          {plan.skills.length ? (
            <section className={sectionClass} data-testid="agent-import-skills">
              <h3 className={headingClass}>
                <Trans>Skills</Trans>
              </h3>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                <Trans>Skills join the library all your bots share.</Trans>
              </p>
              <ul className="mt-2">
                {plan.skills.map(
                  ({ id, title, name: savedAs, content, description, warnings, status }) =>
                    item(
                      id,
                      savedAs === title ? title : t`${title}, saved as ${savedAs}`,
                      content,
                      statusNote(status, warnings),
                      description,
                      status.kind === "unsupported",
                    ),
                )}
              </ul>
            </section>
          ) : null}
          {plan.model ? (
            <section className={sectionClass} data-testid="agent-import-model">
              <h3 className={headingClass}>
                <Trans>Model</Trans>
              </h3>
              <ul className="mt-2">
                {item(
                  plan.model.id,
                  plan.model.title,
                  `${plan.model.provider}\n${plan.model.modelId}`,
                  note(
                    statusText.status(
                      modelUsable
                        ? { kind: "ready" }
                        : plan.model.status === "unknown"
                          ? { kind: "unsupported", reason: "not_in_catalog" }
                          : {
                              kind: "needs_setup",
                              needs: [{ kind: "api_key", provider: plan.model.provider }],
                            },
                    ),
                  ),
                  undefined,
                  !modelUsable,
                )}
              </ul>
            </section>
          ) : null}
          {plan.mcpServers.length ? (
            <section className={sectionClass} data-testid="agent-import-mcp">
              <h3 className={headingClass}>
                <Trans>MCP servers</Trans>
              </h3>
              <ul className="mt-2">
                {plan.mcpServers.map(({ id, title, name: savedAs, content, warnings, status }) =>
                  item(
                    id,
                    savedAs === title ? title : t`${title}, saved as ${savedAs}`,
                    content,
                    statusNote(status, warnings),
                    undefined,
                    status.kind === "unsupported",
                  ),
                )}
              </ul>
            </section>
          ) : null}
          {plan.routines.length ? (
            <section className={sectionClass} data-testid="agent-import-routines">
              <h3 className={headingClass}>
                <Trans>Routines</Trans>
              </h3>
              <ul className="mt-2">
                {plan.routines.map((entry) =>
                  item(
                    entry.id,
                    entry.title,
                    entry.content,
                    statusNote(entry.status, entry.warnings),
                  ),
                )}
              </ul>
            </section>
          ) : null}
          {secretsAvailable ? (
            <section className={sectionClass} data-testid="agent-import-keys">
              <Label className="min-h-9 gap-3 font-normal text-[14px] text-foreground">
                <Checkbox
                  checked={includeSecrets}
                  disabled={busy}
                  onCheckedChange={(checked) => void toggleSecrets(checked)}
                />
                <Trans>Include API keys</Trans>
              </Label>
              {plan.apiKeys.length ? (
                <>
                  <h3 className={`mt-3 ${headingClass}`}>
                    <Trans>API keys</Trans>
                  </h3>
                  <ul className="mt-2">
                    {plan.apiKeys.map((entry) => item(entry.id, entry.title, entry.provider))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
          {plan.skipped.length ? (
            <Collapsible className={sectionClass} data-testid="agent-import-skipped">
              <h3 className={headingClass}>
                <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-sm text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <Trans>Not imported</Trans>
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 -rotate-90 text-muted-foreground transition-transform group-aria-expanded:rotate-0 motion-reduce:transition-none"
                  />
                </CollapsibleTrigger>
              </h3>
              <CollapsibleContent>
                <ul className="mt-2 text-[13px] text-muted-foreground">
                  {plan.skipped.map((entry, index) => (
                    <li key={`${index}:${entry.path}`} className="py-1">
                      {entry.path} · {skipReason(entry.reason)}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
          <label htmlFor={`${ids}-name`} className={`mt-6 block ${headingClass}`}>
            <Trans>Name</Trans>
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder={t`Name this bot`}
              className="mt-2"
            />
          </label>
          {plan.suggestedDescription ? (
            <label htmlFor={`${ids}-description`} className={`mt-6 block ${headingClass}`}>
              <Trans>Description</Trans>
              <Input
                id={`${ids}-description`}
                value={description}
                maxLength={BOT_DESCRIPTION_MAX_LENGTH}
                onChange={(event) => setDescription(event.target.value)}
                className="mt-2"
              />
            </label>
          ) : null}
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
          <div className={page ? "mt-8 flex gap-3" : "mt-5"}>
            <Button disabled={!name.trim() || tooLong || busy} onClick={() => void create()}>
              {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
            {page ? (
              <Button variant="outline" disabled={busy} onClick={() => setPlan(null)}>
                <Trans>Back</Trans>
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div data-testid="agent-import-choose" className={page ? "mt-8" : undefined}>
          {page ? (
            <ToggleGroup
              aria-label={t`Import an agent`}
              value={[kind]}
              onValueChange={([next]) => {
                if (next) setKind(next as "folder" | "document");
              }}
              spacing={1}
              className="grid w-full grid-cols-2 rounded-lg bg-muted p-1"
            >
              <ToggleGroupItem
                value="folder"
                className="aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>OpenClaw or Hermes</Trans>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="document"
                className="aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>Another assistant</Trans>
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <section className={page ? (kind === "folder" ? "mt-6" : "hidden") : undefined}>
            {page ? null : (
              <h3 className={headingClass}>
                <Trans>OpenClaw or Hermes</Trans>
              </h3>
            )}
            <input
              ref={(node) => {
                folderInput.current = node;
                node?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              data-testid="agent-import-folder"
              className="hidden"
              onChange={(event) => {
                void pickFolder(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={archiveInput}
              type="file"
              accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
              data-testid="agent-import-archive"
              className="hidden"
              onChange={(event) => {
                void pickArchive(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div className={page ? "grid gap-3 sm:grid-cols-2" : "mt-2 flex gap-2"}>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => folderInput.current?.click()}
              >
                <Trans>Choose folder</Trans>
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => archiveInput.current?.click()}
              >
                <Trans>Choose backup</Trans>
              </Button>
            </div>
          </section>
          <section className={page ? (kind === "document" ? "mt-6" : "hidden") : sectionClass}>
            {page ? null : (
              <h3 className={headingClass}>
                <Trans>Another assistant</Trans>
              </h3>
            )}
            <Button
              variant="outline"
              className={page ? "w-full" : "mt-2"}
              onClick={() => void copyPrompt()}
            >
              {copied ? <Trans>Copied</Trans> : <Trans>Copy prompt</Trans>}
            </Button>
            <Textarea
              aria-label={t`Paste the reply`}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder={t`Paste the reply`}
              rows={5}
              className="mt-3"
            />
            <input
              ref={fileInput}
              type="file"
              accept=".md,text/markdown"
              data-testid="agent-import-document"
              className="hidden"
              onChange={(event) => {
                void pickDocument(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="mt-3 flex gap-2">
              <Button disabled={!reply.trim() || busy} onClick={() => void previewDocument(reply)}>
                <Trans>Continue</Trans>
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Trans>Choose file</Trans>
              </Button>
            </div>
          </section>
          {page ? (
            <Button variant="outline" className="mt-8" onClick={onBack}>
              <Trans>Back</Trans>
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
