import { Trans, useLingui } from "@lingui/react/macro";
import { BOT_NAME_MAX_LENGTH, BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import type { BotPackageImportState } from "@rakazo/core";
import { createBotPackageImport, newClientId } from "@rakazo/core";
import { Button, Input, Switch, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { readBotPackageFile } from "../lib/bot-package-file";
import { createSpaceRpc } from "../lib/rpc";
import { BotPackageDocumentView, BotPackageLeftOutList } from "./BotPackageDocumentView";
import { BotPackageSkills } from "./BotPackageTools";

export function BotPackageImport({
  spaceId,
  isCurrent,
  onImported,
  onOpen,
  onConnections,
  onCancel,
}: {
  spaceId: string;
  isCurrent(): boolean;
  onImported(): void;
  onOpen(botId: string): void;
  onConnections(): void;
  onCancel(): void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [state, setState] = useState<BotPackageImportState | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const manager = useRef<ReturnType<typeof createBotPackageImport> | null>(null);
  const current = useRef<() => boolean>(() => false);
  const fileGeneration = useRef(0);
  const imported = useRef<string | null>(null);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && isCurrent();
    setReading(false);
    setFileError(null);
    current.current = valid;
    const client = createSpaceRpc(spaceId, valid);
    const review = createBotPackageImport({
      preview: (input, signal) => client.botPackages.preview(input, { signal }),
      import: (input, signal) => client.botPackages.import(input, { signal }),
      status: (input, signal) => client.botPackages.status(input, { signal }),
      recent: (signal) => client.botPackages.recent(undefined, { signal }),
      resume: (input, signal) => client.botPackages.resume(input, { signal }),
      cancel: (input, signal) => client.botPackages.cancel(input, { signal }),
      newNonce: newClientId,
      isCurrent: valid,
      changed: setState,
    });
    manager.current = review;
    return () => {
      active = false;
      fileGeneration.current++;
      review.dispose();
      manager.current = null;
    };
  }, [spaceId, isCurrent]);
  const receipt = state?.receipt;
  useEffect(() => {
    if (
      receipt?.status !== "completed" ||
      !current.current() ||
      imported.current === receipt.importId
    )
      return;
    imported.current = receipt.importId;
    onImportedRef.current();
  }, [receipt]);
  const phase = state?.phase ?? "editing";
  const busy = phase === "importing" || phase === "checking";
  const locked =
    busy || phase === "unknown" || receipt?.status === "importing" || receipt?.status === "failed";
  const preview = state?.preview;
  function edit(input: { source?: string; name?: string; includeMemory?: boolean }) {
    fileGeneration.current++;
    setReading(false);
    setFileError(null);
    manager.current?.edit(input);
  }
  async function read(file: File) {
    const version = ++fileGeneration.current;
    setReading(true);
    setFileError(null);
    try {
      const source = await readBotPackageFile(
        file,
        () => version === fileGeneration.current && current.current(),
      );
      if (version === fileGeneration.current && current.current())
        manager.current?.edit({ source });
    } catch {
      if (version === fileGeneration.current && current.current())
        setFileError(t`Could not read this package. Use a UTF-8 JSON file up to 4 MiB.`);
    } finally {
      if (version === fileGeneration.current && current.current()) setReading(false);
    }
  }
  return (
    <section className="space-y-4" data-testid="bot-package-import">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-heading3 font-medium">
          <Trans>Import bot</Trans>
        </h2>
        <Button variant="ghost" onClick={onCancel}>
          <Trans>Close</Trans>
        </Button>
      </div>
      {phase !== "completed" ? (
        <>
          <label htmlFor={`${ids}-source`} className="block text-body">
            <Trans>Bot package or Grok JSON</Trans>
            <Textarea
              id={`${ids}-source`}
              aria-label={t`Bot package or Grok JSON`}
              value={state?.source ?? ""}
              maxLength={BOT_PACKAGE_MAX_BYTES}
              rows={7}
              disabled={locked}
              onChange={(event) => edit({ source: event.target.value })}
              className="mt-2 font-mono text-label"
            />
          </label>
          <Input
            aria-label={t`Choose package file`}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            disabled={locked || reading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void read(file);
            }}
          />
          <label htmlFor={`${ids}-name`} className="block text-body">
            <Trans>Name</Trans>
            <Input
              id={`${ids}-name`}
              aria-label={t`Imported bot name`}
              value={state?.name ?? ""}
              maxLength={BOT_NAME_MAX_LENGTH}
              placeholder={preview?.document.profile.name ?? ""}
              disabled={locked}
              onChange={(event) => edit({ name: event.target.value })}
            />
          </label>
          <label
            htmlFor={`${ids}-memory`}
            className="flex items-center justify-between gap-3 text-body"
          >
            <span>
              <Trans>Include memory</Trans>
              {preview ? ` · ${preview.availableMemoryCount}` : ""}
            </span>
            <Switch
              id={`${ids}-memory`}
              checked={state?.includeMemory ?? false}
              disabled={locked}
              onCheckedChange={(includeMemory) => edit({ includeMemory })}
            />
          </label>
          <Button
            variant="outline"
            disabled={locked || reading || !state?.source.trim()}
            onClick={() => void manager.current?.preview()}
          >
            {phase === "previewing" ? <Trans>Previewing…</Trans> : <Trans>Preview</Trans>}
          </Button>
        </>
      ) : null}
      {fileError ? (
        <p role="alert" className="text-body text-destructive">
          {fileError}
        </p>
      ) : null}
      {state?.error ? (
        <p role="alert" className="text-body text-destructive">
          {phase === "editing" || phase === "review"
            ? t`Could not preview this package.`
            : t`Could not confirm import. Check status before trying again.`}
        </p>
      ) : null}
      {preview && phase !== "completed" ? (
        <>
          <BotPackageDocumentView document={preview.document} />
          <BotPackageLeftOutList items={preview.leftOut} />
          <p className="text-body text-muted-foreground">
            <Trans>Skills stay off. Routines stay paused. Connections need setup.</Trans>
          </p>
          <p className="text-body text-muted-foreground">
            <Trans>Models, credentials, files, and chat history are not imported.</Trans>
          </p>
          {phase === "review" ? (
            <Button onClick={() => void manager.current?.confirm()}>
              <Trans>Import as new bot</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
      {phase === "unknown" || receipt?.status === "importing" || receipt?.status === "failed" ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void manager.current?.check()}>
            <Trans>Check status</Trans>
          </Button>
          {state?.canRetry && (receipt || preview) ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void (receipt ? manager.current?.resume() : manager.current?.confirm())
              }
            >
              <Trans>Resume import</Trans>
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => void manager.current?.cancel()}>
            <Trans>Cancel import</Trans>
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <section className="space-y-3" data-testid="bot-package-receipt">
          <h3 className="font-medium" dir="auto">
            {receipt.botName}
          </h3>
          <p>
            {receipt.status === "completed"
              ? t`Bot imported`
              : receipt.status === "removed"
                ? t`This imported bot was removed.`
                : receipt.status === "cancelled"
                  ? t`Import cancelled.`
                  : t`Import needs attention.`}
          </p>
          <BotPackageLeftOutList items={receipt.leftOut} />
          {receipt.status === "completed" && receipt.botId ? (
            <>
              <BotPackageSkills botId={receipt.botId} spaceId={spaceId} isCurrent={isCurrent} />
              {receipt.connections.length ? (
                <div className="space-y-2">
                  {receipt.connections.map((connection) => (
                    <p key={connection.id} className="text-body" dir="auto">
                      {connection.name} · {connection.note}
                    </p>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (current.current()) onConnections();
                    }}
                  >
                    <Trans>Set up connections</Trans>
                  </Button>
                </div>
              ) : null}
              <Button
                onClick={() => {
                  if (current.current() && receipt.botId) onOpen(receipt.botId);
                }}
              >
                <Trans>Open bot</Trans>
              </Button>
            </>
          ) : null}
          {phase === "completed" ? (
            <Button variant="outline" onClick={() => manager.current?.reset()}>
              <Trans>Import another bot</Trans>
            </Button>
          ) : null}
        </section>
      ) : null}
      <Button
        variant="ghost"
        disabled={locked}
        onClick={() => {
          setRecentOpen(!recentOpen);
          if (!recentOpen) void manager.current?.loadRecent();
        }}
      >
        <Trans>Recent imports</Trans>
      </Button>
      {recentOpen ? (
        <div className="space-y-2" data-testid="bot-package-recent">
          {state?.recentLoading ? (
            <p>
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {state?.recentError ? (
            <p role="alert">
              <Trans>Could not load recent imports.</Trans>
            </p>
          ) : null}
          {state?.recent.map((item) => (
            <div key={item.importId} className="flex items-center justify-between gap-3">
              <span dir="auto">{item.botName}</span>
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => void manager.current?.recover(item.clientNonce)}
              >
                <Trans>Review import</Trans>
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
