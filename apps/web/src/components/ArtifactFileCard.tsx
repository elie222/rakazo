import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Download, FileText, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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

  function closePreview() {
    setPreviewOpen(false);
    window.requestAnimationFrame(() => previewButton.current?.focus());
  }

  if (!markdown) {
    return (
      <div>
        <button
          type="button"
          onClick={() => void startDownload()}
          className="rounded-[20px] border border-[#26262A] bg-[#17171A] px-4 py-3 text-left text-[14px] text-[#DFDFE2] hover:bg-[#1F1F22]"
        >
          <div className="font-medium">{props.name}</div>
          <div className="mt-1 text-[#85858A]">
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
        <div className="flex min-w-[280px] overflow-hidden rounded-[20px] border border-[#343438] bg-[#1B1B1E] text-left text-[#DFDFE2]">
          <button
            ref={previewButton}
            type="button"
            aria-label={t`Preview ${props.name}`}
            onClick={() => setPreviewOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-[#222226]"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[#24344A] text-[#68A7FF]">
              <FileText size={21} strokeWidth={1.8} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-medium">{props.name}</span>
              <span className="mt-0.5 block text-[13px] text-[#85858A]">
                {formatBytes(props.size)}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label={t`Download ${props.name}`}
            title={t`Download ${props.name}`}
            onClick={() => void startDownload()}
            className="grid w-14 shrink-0 place-items-center border-l border-[#343438] text-[#9A9AA0] hover:bg-[#222226] hover:text-[#ECECEE]"
          >
            <Download size={19} strokeWidth={1.8} />
          </button>
        </div>
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </div>
      {previewOpen ? <MarkdownPreview {...props} onClose={closePreview} /> : null}
    </>
  );
}

function MarkdownPreview({
  target,
  artifactId,
  name,
  mimeType,
  onClose,
}: ArtifactFileCardProps & { onClose: () => void }) {
  const { t } = useLingui();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; bytes: Uint8Array; markdown: string }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5 backdrop-blur-sm">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t`Close preview`}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(88vh,900px)] w-[min(960px,94vw)] flex-col overflow-hidden rounded-[18px] border border-[#2B2B2F] bg-[#0D0D0F] shadow-2xl"
      >
        <header className="flex h-14 shrink-0 items-center border-b border-[#27272B] px-5">
          <h2
            id={titleId}
            className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#E7E7E9]"
          >
            {name}
          </h2>
          <button
            type="button"
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
            className="grid h-9 w-9 place-items-center rounded-full text-[#929298] hover:bg-[#1D1D20] hover:text-[#ECECEE]"
          >
            <Download size={18} strokeWidth={1.8} />
          </button>
          <button
            ref={closeButton}
            type="button"
            aria-label={t`Close preview`}
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-[#929298] hover:bg-[#1D1D20] hover:text-[#ECECEE]"
          >
            <X size={19} strokeWidth={1.8} />
          </button>
        </header>
        {downloadError ? (
          <div className="shrink-0 px-5 pt-4">
            <DownloadError message={downloadError} />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto w-full max-w-[760px] px-8 py-10 text-[16px] leading-7 text-[#D5D5D8] sm:px-12 sm:py-12">
            {state.status === "loading" ? (
              <div className="text-[#85858A]">
                <Trans>Loading preview…</Trans>
              </div>
            ) : state.status === "error" ? (
              <div className="rounded-[14px] border border-[#5A2A2A] bg-[#2A1717] px-4 py-3 text-[#F1A8A8]">
                {state.message}
              </div>
            ) : (
              <ChatMarkdown>{state.markdown}</ChatMarkdown>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

function DownloadError({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-2 text-left text-[13px] text-[#F1A8A8]">
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
