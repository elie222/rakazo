import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode } from "@rakazo/contracts";
import { AGENT_IMPORT_PROMPT, GROK_BOT_EXPORT_PROMPT } from "@rakazo/core";
import { Button, CopyTextFallback, Textarea, useCopyText } from "@rakazo/ui-web";
import { ArrowLeft, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { AgentImportPlanReview, headingClass, sectionClass } from "./agent-import-plan";
import { useAgentImportSource } from "./use-agent-import-source";

export function AgentImportForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
  const archiveInput = useRef<HTMLInputElement>(null);
  const grokFileInput = useRef<HTMLInputElement>(null);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [reply, setReply] = useState("");
  const [grokReply, setGrokReply] = useState("");
  const [copied, copy, copyFailed, resetCopy] = useCopyText();
  const [grokCopied, copyGrok, grokCopyFailed, resetGrokCopy] = useCopyText();
  const [creating, setCreating] = useState(false);

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
      setCreating(false);
      setBusy(false);
    }
  }

  return (
    <div data-testid="agent-import">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Back`}
            disabled={creating}
            onClick={() => {
              stopReading();
              if (plan) {
                // A copy that failed while the preview was open must not greet the return.
                resetCopy();
                resetGrokCopy();
                setPlan(null);
              } else onClose();
            }}
          >
            <ArrowLeft size={16} strokeWidth={1.8} />
          </Button>
          <span className="text-body text-muted-foreground">
            <Trans>Import an agent</Trans>
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new bot`}
          onClick={() => {
            stopReading();
            onClose();
          }}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="agent-import-error"
          className="mb-3 text-body-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {plan ? (
        <AgentImportPlanReview
          ids={ids}
          plan={plan}
          source={source}
          computerMode={computerMode}
          onComputerModeChange={setComputerMode}
          onCreate={() => void create()}
        />
      ) : (
        <div data-testid="agent-import-choose">
          <section>
            <h3 className={headingClass}>
              <Trans>OpenClaw or Hermes</Trans>
            </h3>
            <input
              ref={(node) => {
                folderInput.current = node;
                if (!node) return;
                node.setAttribute("webkitdirectory", "");
                node.addEventListener("cancel", stopReading);
                return () => {
                  node.removeEventListener("cancel", stopReading);
                  folderInput.current = null;
                };
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
              ref={(node) => {
                archiveInput.current = node;
                if (!node) return;
                node.addEventListener("cancel", stopReading);
                return () => {
                  node.removeEventListener("cancel", stopReading);
                  archiveInput.current = null;
                };
              }}
              type="file"
              accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
              data-testid="agent-import-archive"
              className="hidden"
              onChange={(event) => {
                void pickArchive(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div className="mt-2 flex gap-2">
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
          <section className={sectionClass} data-testid="agent-import-grok">
            <h3 className={headingClass}>
              <Trans>Grok Bot</Trans>
            </h3>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => copyGrok(GROK_BOT_EXPORT_PROMPT)}
            >
              {grokCopied ? <Trans>Copied</Trans> : <Trans>Copy prompt</Trans>}
            </Button>
            <CopyTextFallback
              open={grokCopyFailed}
              onOpenChange={resetGrokCopy}
              text={GROK_BOT_EXPORT_PROMPT}
              label={t`Copy prompt`}
            />
            <Textarea
              aria-label={t`Paste the reply`}
              value={grokReply}
              onChange={(event) => setGrokReply(event.target.value)}
              placeholder={t`Paste the reply`}
              rows={5}
              className="mt-3"
            />
            <input
              ref={(node) => {
                grokFileInput.current = node;
                if (!node) return;
                node.addEventListener("cancel", stopReading);
                return () => {
                  node.removeEventListener("cancel", stopReading);
                  grokFileInput.current = null;
                };
              }}
              type="file"
              multiple
              accept=".json,.md,.txt,application/json,text/plain,text/markdown"
              data-testid="agent-import-grok-file"
              className="hidden"
              onChange={(event) => {
                void pickGrokFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="mt-3 flex gap-2">
              <Button
                disabled={!grokReply.trim() || busy}
                onClick={() => void previewGrokReply(grokReply)}
              >
                <Trans>Continue</Trans>
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => grokFileInput.current?.click()}
              >
                <Trans>Choose file</Trans>
              </Button>
            </div>
            {grokBots.length > 1 ? (
              <>
                <p className="mt-3 text-body-sm text-muted-foreground">
                  <Trans>Which Bot?</Trans>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {grokBots.map((bot) => (
                    <Button
                      key={bot.name}
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
          </section>
          <section className={sectionClass} data-testid="agent-import-another">
            <h3 className={headingClass}>
              <Trans>Another assistant</Trans>
            </h3>
            <Button variant="outline" className="mt-2" onClick={() => copy(AGENT_IMPORT_PROMPT)}>
              {copied ? <Trans>Copied</Trans> : <Trans>Copy prompt</Trans>}
            </Button>
            <CopyTextFallback
              open={copyFailed}
              onOpenChange={resetCopy}
              text={AGENT_IMPORT_PROMPT}
              label={t`Copy prompt`}
            />
            <Textarea
              aria-label={t`Paste the reply`}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder={t`Paste the reply`}
              rows={5}
              className="mt-3"
            />
            <input
              ref={(node) => {
                fileInput.current = node;
                if (!node) return;
                node.addEventListener("cancel", stopReading);
                return () => {
                  node.removeEventListener("cancel", stopReading);
                  fileInput.current = null;
                };
              }}
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
        </div>
      )}
    </div>
  );
}
