import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Download, FileText, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type ArtifactTarget,
  downloadArtifact,
  downloadArtifactBytes,
  fetchArtifactBytes,
} from "../lib/artifact-open";

type ArtifactFileCardProps = {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
};

export function ArtifactFileCard(props: ArtifactFileCardProps) {
  const { t } = useLingui();
  const markdown = props.mimeType === "text/markdown";
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function startDownload() {
    setDownloadError(null);
    try {
      await downloadArtifact(props.target, props.artifactId, props.name, props.mimeType);
    } catch {
      setDownloadError(t`Could not download ${props.name}. Try again.`);
    }
  }

  if (!markdown) {
    return (
      <div>
        <button
          type="button"
          onClick={() => void startDownload()}
          className="rounded-2xl border border-border bg-card px-4 py-3 text-left text-[14px] text-foreground hover:bg-accent"
        >
          <div className="font-medium">{props.name}</div>
          <div className="mt-1 text-muted-foreground">
            {props.mimeType} · {formatBytes(props.size)}
          </div>
        </button>
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </div>
    );
  }

  return (
    <>
      <div>
        <div className="flex min-w-[280px] overflow-hidden rounded-2xl border border-border bg-card text-left text-foreground">
          <button
            ref={previewButton}
            type="button"
            aria-label={t`Preview ${props.name}`}
            onClick={() => setPreviewOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-accent"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-muted text-foreground">
              <FileText size={21} strokeWidth={1.8} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-medium">{props.name}</span>
              <span className="mt-0.5 block text-[13px] text-muted-foreground">
                {formatBytes(props.size)}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label={t`Download ${props.name}`}
            title={t`Download ${props.name}`}
            onClick={() => void startDownload()}
            className="grid w-14 shrink-0 place-items-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Download size={19} strokeWidth={1.8} />
          </button>
        </div>
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={previewButton}
          className="flex h-[min(88vh,900px)] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <MarkdownPreview {...props} closeButtonRef={closeButton} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function MarkdownPreview({
  target,
  artifactId,
  name,
  mimeType,
  closeButtonRef,
}: ArtifactFileCardProps & { closeButtonRef: RefObject<HTMLButtonElement | null> }) {
  const { t } = useLingui();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; bytes: Uint8Array; markdown: string }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    const artifactTarget: ArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
    void fetchArtifactBytes(artifactTarget, artifactId)
      .then((bytes) => {
        if (cancelled) return;
        try {
          const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          setState({ status: "ready", bytes, markdown });
        } catch {
          setState({ status: "error", message: t`This file is not valid UTF-8 Markdown.` });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : t`Could not load this file.`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, targetBotId, targetGroupId, t]);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-5">
        <DialogTitle className="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-foreground">
          {name}
        </DialogTitle>
        <Button
          variant="ghost"
          size="icon-lg"
          className="rounded-full text-muted-foreground"
          aria-label={t`Download ${name}`}
          title={t`Download ${name}`}
          onClick={() =>
            void (async () => {
              setDownloadError(null);
              try {
                if (state.status === "ready") downloadArtifactBytes(name, mimeType, state.bytes);
                else await downloadArtifact(target, artifactId, name, mimeType);
              } catch {
                setDownloadError(t`Could not download ${name}. Try again.`);
              }
            })()
          }
        >
          <Download />
        </Button>
        <DialogClose
          ref={closeButtonRef}
          aria-label={t`Close preview`}
          render={
            <Button variant="ghost" size="icon-lg" className="rounded-full text-muted-foreground" />
          }
        >
          <X />
        </DialogClose>
      </header>
      {downloadError ? (
        <div className="shrink-0 px-5 pt-4">
          <DownloadError message={downloadError} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-[760px] px-8 py-10 text-[16px] leading-7 text-foreground sm:px-12 sm:py-12">
          {state.status === "loading" ? (
            <div className="text-muted-foreground">
              <Trans>Loading preview…</Trans>
            </div>
          ) : state.status === "error" ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
              {state.message}
            </div>
          ) : (
            <ChatMarkdown>{state.markdown}</ChatMarkdown>
          )}
        </article>
      </div>
    </>
  );
}

function DownloadError({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-2 text-left text-[13px] text-destructive">
      {message}
    </div>
  );
}

function formatBytes(size: number) {
  const locale = i18n.locale || "en";
  if (size < 1024) return t`${size} B`;
  const format = (value: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  if (size < 1024 * 1024) return t`${format(size / 1024)} KB`;
  return t`${format(size / (1024 * 1024))} MB`;
}
