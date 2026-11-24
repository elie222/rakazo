import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { BOT_COLOR_LIST, BOT_DESCRIPTION_MAX_LENGTH } from "@rakazo/contracts";
import type { AgentImportAssistant } from "@rakazo/core";
import { AGENT_IMPORT_ASSISTANTS, AGENT_IMPORT_PROMPT, GROK_BOT_EXPORT_PROMPT } from "@rakazo/core";
import { Button, CopyTextFallback, Spinner, Textarea, useCopyText } from "@rakazo/ui-web";
import { ArrowLeft, Check, Copy, MessagesSquare, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useId, useState } from "react";
import { rpc } from "../../../lib/query/rpc";
import { useEventListener } from "../../../lib/use-event-listener";
import { AgentImportPlanReview } from "./agent-import-plan";
import { useAgentImportSource } from "./use-agent-import-source";

/** What the import comes from: a named assistant, or any other one that can answer a prompt. */
type Origin = AgentImportAssistant["id"] | "another";

/** One of the bot colours per card, so each origin is told apart at a glance. */
const ORIGIN_COLORS = ["orange", "violet", "cyan", "blue"].map(
  (id) => BOT_COLOR_LIST.find((color) => color.id === id)!.hex,
);

function OriginCard({
  name,
  color,
  icon,
  onClick,
}: {
  name: string;
  color: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 p-3 text-start outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        aria-hidden
        style={{
          backgroundImage: `linear-gradient(135deg, color-mix(in oklab, ${color} 65%, white), ${color})`,
        }}
        className="grid size-9 shrink-0 place-items-center rounded-lg text-body font-semibold text-white"
      >
        {icon ?? name.charAt(0)}
      </span>
      <span className="truncate text-body text-foreground">{name}</span>
    </button>
  );
}

/**
 * An assistant with no export: copy a prompt to send it, then paste its reply or choose the
 * file it made. The reply is held by the form so it survives a trip to the preview and back.
 */
function PromptReplySteps({
  testId,
  fileTestId,
  send,
  prompt,
  reply,
  onReplyChange,
  accept,
  multiple = false,
  busy,
  onContinue,
  onFiles,
  onCancelRead,
  children,
}: {
  testId: string;
  fileTestId: string;
  send: ReactNode;
  prompt: string;
  reply: string;
  onReplyChange: (reply: string) => void;
  accept: string;
  multiple?: boolean;
  busy: boolean;
  onContinue: () => void;
  onFiles: (files: FileList | null) => void;
  onCancelRead: () => void;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const replyId = useId();
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null);
  useEventListener(fileInput, "cancel", onCancelRead);
  // Unmounted while the preview is open, so a copy that fails then never greets the return.
  const [copied, copy, copyFailed, resetCopy] = useCopyText();
  return (
    <section data-testid={testId}>
      <ol className="list-decimal space-y-5 ps-5 text-body text-foreground">
        <li>
          <p>{send}</p>
          {/* The start of the prompt, so it is plain what is being sent; Copy takes all of it. */}
          <div className="relative mt-2 rounded-lg border border-border/60 bg-background">
            <p
              data-testid="agent-import-prompt"
              className="h-24 overflow-hidden whitespace-pre-wrap px-3 py-2 pe-11 text-body-sm text-muted-foreground mask-b-from-40%"
            >
              {prompt}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute end-1.5 top-1.5"
              aria-label={copied ? t`Copied` : t`Copy prompt`}
              onClick={() => copy(prompt)}
            >
              {copied ? (
                <Check size={16} strokeWidth={1.8} />
              ) : (
                <Copy size={16} strokeWidth={1.8} />
              )}
            </Button>
          </div>
          <CopyTextFallback
            open={copyFailed}
            onOpenChange={resetCopy}
            text={prompt}
            label={t`Copy prompt`}
          />
        </li>
        <li>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={replyId}>
              <Trans>Paste the reply</Trans>
            </label>
            {/* The other way to hand the reply over, so it sits with the box it replaces. */}
            <Button
              variant="ghost"
              size="sm"
              className="-me-2 text-muted-foreground"
              disabled={busy}
              onClick={() => fileInput?.click()}
            >
              <Trans>Choose file</Trans>
            </Button>
          </div>
          <Textarea
            id={replyId}
            value={reply}
            onChange={(event) => onReplyChange(event.target.value)}
            rows={6}
            className="mt-2 max-h-64"
          />
          <input
            ref={setFileInput}
            type="file"
            multiple={multiple}
            accept={accept}
            data-testid={fileTestId}
            className="hidden"
            onChange={(event) => {
              onFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button disabled={!reply.trim() || busy} onClick={onContinue}>
              <Trans>Continue</Trans>
            </Button>
            {busy ? <Reading /> : null}
          </div>
          {children}
        </li>
      </ol>
    </section>
  );
}

function Reading() {
  const { t } = useLingui();
  return <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />;
}

/**
 * Import an agent, one step at a time: where it comes from, its files or reply, then what
 * would be imported.
 */
export function AgentImportForm({
  onClose,
  onCreated,
  onCreatingChange,
}: {
  onClose: () => void;
  onCreated: (bot: Bot) => void;
  /** Told while the bot is being created, when leaving would lose track of it. */
  onCreatingChange?: (creating: boolean) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [folderInput, setFolderInput] = useState<HTMLInputElement | null>(null);
  const source = useAgentImportSource();
  const {
    files,
    includeSecrets,
    skillFiles,
    importKey,
    plan,
    setPlan,
    unchecked,
    destinations,
    name,
    description,
    busy,
    setBusy,
    error,
    setError,
    failure,
    pickFolder,
    pickArchive,
    previewDocument,
    pickDocument,
    grokBots,
    previewGrokReply,
    previewGrokBot,
    pickGrokFiles,
    stopReading,
    selectedInstructions,
    chosen,
    modelUsable,
    ready,
  } = source;
  const [archiveInput, setArchiveInput] = useState<HTMLInputElement | null>(null);
  useEventListener(folderInput, "cancel", stopReading);
  useEventListener(archiveInput, "cancel", stopReading);
  const folderRef = useCallback((node: HTMLInputElement | null) => {
    node?.setAttribute("webkitdirectory", "");
    setFolderInput(node);
  }, []);
  const [reply, setReply] = useState("");
  const [grokReply, setGrokReply] = useState("");
  const [creating, setCreatingState] = useState(false);
  function setCreating(next: boolean) {
    setCreatingState(next);
    onCreatingChange?.(next);
  }
  const assistant = AGENT_IMPORT_ASSISTANTS.find((item) => item.id === origin);
  const assistantName = assistant?.name;

  async function create() {
    if (!plan || !ready || busy) return;
    setError(null);
    setCreating(true);
    setBusy(true);
    try {
      const bot = await rpc.bots.importCreate({
        importKey: importKey.current ?? undefined,
        files,
        includeSecrets,
        skillFiles,
        name: name.trim(),
        // The review has no field for it, so an over-long suggestion is cut, never refused.
        description: description.trim().slice(0, BOT_DESCRIPTION_MAX_LENGTH),
        computerMode: "team",
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
          // Not asked about: what the import cannot set up always goes to the new bot's chat.
          leftovers: chosen(plan.leftovers).map((item) => item.id),
        },
      });
      onCreated(bot);
    } catch (err) {
      failure(err, t`Could not create bot`);
      setCreating(false);
      setBusy(false);
    }
  }

  function back() {
    stopReading();
    setError(null);
    if (plan) setPlan(null);
    else setOrigin(null);
  }

  function step() {
    if (plan) return <AgentImportPlanReview ids={ids} plan={plan} source={source} />;
    if (!origin)
      return (
        <div data-testid="agent-import-choose" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AGENT_IMPORT_ASSISTANTS.map((item, index) => (
            <OriginCard
              key={item.id}
              name={item.name}
              color={ORIGIN_COLORS[index % ORIGIN_COLORS.length]!}
              onClick={() => setOrigin(item.id)}
            />
          ))}
          <OriginCard
            name={t`Another assistant`}
            color={ORIGIN_COLORS.at(-1)!}
            icon={<MessagesSquare size={16} strokeWidth={1.8} />}
            onClick={() => setOrigin("another")}
          />
        </div>
      );
    if (assistant?.home) {
      const { home } = assistant;
      return (
        <section data-testid="agent-import-files">
          <p className="text-body text-foreground">
            <Trans>Choose your {home} folder, or a backup of it.</Trans>
          </p>
          <input
            ref={folderRef}
            type="file"
            data-testid="agent-import-folder"
            className="hidden"
            onChange={(event) => {
              void pickFolder(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={setArchiveInput}
            type="file"
            accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
            data-testid="agent-import-archive"
            className="hidden"
            onChange={(event) => {
              void pickArchive(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button disabled={busy} onClick={() => folderInput?.click()}>
              <Trans>Choose folder</Trans>
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => archiveInput?.click()}>
              <Trans>Choose backup</Trans>
            </Button>
            {busy ? <Reading /> : null}
          </div>
        </section>
      );
    }
    if (origin === "another")
      return (
        <PromptReplySteps
          testId="agent-import-another"
          fileTestId="agent-import-document"
          send={<Trans>Send this prompt to your assistant</Trans>}
          prompt={AGENT_IMPORT_PROMPT}
          reply={reply}
          onReplyChange={(reply) => {
            stopReading();
            setReply(reply);
          }}
          accept=".md,text/markdown"
          busy={busy}
          onContinue={() => void previewDocument(reply)}
          onFiles={(list) => void pickDocument(list)}
          onCancelRead={stopReading}
        />
      );
    return (
      <PromptReplySteps
        testId="agent-import-grok"
        fileTestId="agent-import-grok-file"
        send={<Trans>Send this prompt to {assistantName}</Trans>}
        prompt={GROK_BOT_EXPORT_PROMPT}
        reply={grokReply}
        onReplyChange={(reply) => {
          stopReading();
          setGrokReply(reply);
        }}
        accept=".json,.md,.txt,application/json,text/plain,text/markdown"
        multiple
        busy={busy}
        onContinue={() => void previewGrokReply(grokReply)}
        onFiles={(list) => void pickGrokFiles(list)}
        onCancelRead={stopReading}
      >
        {grokBots.length > 1 ? (
          <>
            <p className="mt-4 text-body-sm text-muted-foreground">
              <Trans>Which Bot?</Trans>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {grokBots.map((bot, index) => (
                <Button
                  key={`${bot.exportId ?? bot.name}:${index}`}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void previewGrokBot(bot)}
                >
                  {bot.name}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </PromptReplySteps>
    );
  }

  return (
    <div data-testid="agent-import" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-6 pt-5 pb-4">
        {origin ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ms-2"
            aria-label={t`Back`}
            disabled={creating}
            onClick={back}
          >
            <ArrowLeft size={16} strokeWidth={1.8} />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-body-lg font-medium text-foreground">
          {origin === "another" ? (
            <Trans>Another assistant</Trans>
          ) : (
            (assistantName ?? <Trans>Import an agent</Trans>)
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close`}
          disabled={creating}
          onClick={() => {
            stopReading();
            onClose();
          }}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {error ? (
          <p
            role="alert"
            data-testid="agent-import-error"
            className="mb-3 text-body-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {step()}
      </div>
      {plan ? (
        <div className="flex justify-end border-t border-border/60 px-6 py-4">
          <Button disabled={!ready || busy} onClick={() => void create()}>
            {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
