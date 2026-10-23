import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentImportFile,
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSkipReason,
  Bot,
  ComputerMode,
} from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
  AGENT_IMPORT_NOT_FOUND,
  AGENT_IMPORT_PROMPT,
  agentImportFolder,
  combineImportedInstructions,
  hasAgentImportSecrets,
  isAgentImportSecretFile,
  stripAgentImportSecrets,
} from "@rakazo/core";
import {
  Button,
  Checkbox,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Textarea,
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

const sectionClass = "mt-6";
const headingClass = "text-sm text-foreground";

/** Import an OpenClaw or Hermes folder, or another assistant's exported document, as a new bot. */
export function AgentImportForm({
  onBack,
  onCancel,
  onCreated,
}: {
  onBack: () => void;
  onCancel: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<AgentImportFile[]>([]);
  // A chosen folder's files by upload path, with their path in the agent's home.
  const [folder, setFolder] = useState<{ path: string; home: string; content: string }[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [plan, setPlan] = useState<AgentImportPlan | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [destinations, setDestinations] = useState<Record<string, AgentImportMemoryDestination>>(
    {},
  );
  const [name, setName] = useState("");
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

  async function preview(next: AgentImportFile[], secrets = false, keepChoices = false) {
    setError(null);
    if (next.length === 0) {
      setError(notFound());
      return;
    }
    setBusy(true);
    try {
      const found = await rpc.bots.importPreview({ files: next, includeSecrets: secrets });
      setFiles(next);
      setIncludeSecrets(secrets);
      // Turning the API key opt-in on or off keeps what the user already chose.
      if (!keepChoices) {
        setUnchecked(new Set());
        setDestinations({});
        setName(found.suggestedName);
      }
      setPlan(found);
    } catch (err) {
      failure(err, t`Could not read these files`);
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder(list: FileList | null) {
    // Only the files an import uses are read; the rest stay on this device.
    const byPath = new Map(
      [...(list ?? [])].map((file) => [file.webkitRelativePath || file.name, file]),
    );
    const { files: used } = agentImportFolder([...byPath.keys()]);
    const read = await Promise.all(
      [...used].map(async ([path, home]) => ({
        path,
        home,
        content: await byPath.get(path)!.text(),
      })),
    );
    setFolder(read);
    await preview(folderUpload(read, false));
  }

  /**
   * Without the API key opt-in, secret files are not sent and settings files are sent
   * without credential values, using the same function the server applies.
   */
  function folderUpload(
    entries: { path: string; home: string; content: string }[],
    secrets: boolean,
  ): AgentImportFile[] {
    return entries.flatMap(({ path, home, content }) => {
      if (secrets) return [{ path, content }];
      if (isAgentImportSecretFile(home)) return [];
      return [{ path, content: stripAgentImportSecrets(home, content) }];
    });
  }

  const secretsAvailable = folder.some(({ home, content }) => hasAgentImportSecrets(home, content));

  async function pickDocument(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setFolder([]);
    await preview([{ path: "agent.md", content: await file.text() }]);
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
      const bot = await rpc.bots.importCreate({
        files,
        includeSecrets,
        name: name.trim(),
        computerMode,
        selection: {
          instructions: selectedInstructions.map((item) => item.id),
          memory: plan.memory
            .filter((item) => !unchecked.has(item.id))
            .map((item) => ({ id: item.id, destination: destinations[item.id] ?? "bot" })),
          skills: chosen(plan.skills).map((item) => item.id),
          model: Boolean(plan.model && modelUsable && !unchecked.has(plan.model.id)),
          mcpServers: chosen(plan.mcpServers).map((item) => item.id),
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

  const skipReason = (reason: AgentImportSkipReason) =>
    ({
      runtime: t`Not used by Rakazo`,
      invalid_skill: t`Not a valid skill`,
      builtin: t`Built in`,
      unsupported: t`Not supported in Rakazo`,
      connected: t`Already connected`,
    })[reason];
  const note = (text: string) => (
    <span className="shrink-0 text-[12.5px] text-muted-foreground">{text}</span>
  );

  return (
    <div data-testid="agent-import">
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
      {error ? (
        <p
          role="alert"
          data-testid="agent-import-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      {plan ? (
        <div data-testid="agent-import-preview">
          {plan.instructions.length ? (
            <section className={sectionClass} data-testid="agent-import-instructions">
              <h3 className={headingClass}>
                <Trans>Instructions</Trans>
              </h3>
              <ul className="mt-2">
                {plan.instructions.map((entry) => item(entry.id, entry.title, entry.content))}
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
                    </NativeSelect>,
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
              <ul className="mt-2">
                {plan.skills.map(({ id, title, name: savedAs, content, description }) =>
                  item(
                    id,
                    savedAs === title ? title : t`${title}, saved as ${savedAs}`,
                    content,
                    undefined,
                    description,
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
                  modelUsable
                    ? undefined
                    : note(
                        plan.model.status === "unknown"
                          ? t`Not supported in Rakazo`
                          : t`Needs this provider's API key`,
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
                {plan.mcpServers.map(({ id, title, name: savedAs, content }) =>
                  item(id, savedAs === title ? title : t`${title}, saved as ${savedAs}`, content),
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
                {plan.routines.map((entry) => item(entry.id, entry.title, entry.content))}
              </ul>
            </section>
          ) : null}
          {secretsAvailable ? (
            <section className={sectionClass} data-testid="agent-import-keys">
              <Label className="min-h-9 gap-3 font-normal text-[14px] text-foreground">
                <Checkbox
                  checked={includeSecrets}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    void preview(folderUpload(folder, checked), checked)
                  }
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
          <label htmlFor={`${ids}-name`} className="mt-6 block text-sm text-foreground">
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
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
          <Button
            className="mt-5"
            disabled={!name.trim() || tooLong || busy}
            onClick={() => void create()}
          >
            {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
          </Button>
        </div>
      ) : (
        <div data-testid="agent-import-choose">
          <section>
            <h3 className={headingClass}>
              <Trans>OpenClaw or Hermes</Trans>
            </h3>
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
            <Button
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              <Trans>Choose folder</Trans>
            </Button>
          </section>
          <section className={sectionClass}>
            <h3 className={headingClass}>
              <Trans>Another assistant</Trans>
            </h3>
            <Button variant="outline" className="mt-2" onClick={() => void copyPrompt()}>
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
              <Button
                disabled={!reply.trim() || busy}
                onClick={() => {
                  setFolder([]);
                  void preview([{ path: "agent.md", content: reply }]);
                }}
              >
                <Trans>Continue</Trans>
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Trans>Choose file</Trans>
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
