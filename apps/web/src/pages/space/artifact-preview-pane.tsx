import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Artifact } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { Button, CopyTextFallback, OptionSelect, Spinner } from "@rakazo/ui-web";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, Lock, Maximize2, Minimize2 } from "lucide-react";
import { useMemo, useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { VideoPreview } from "../../components/messages/ArtifactFileCard";
import { PdfViewer } from "../../components/messages/PdfViewer";
import { SandboxedHtmlViewer } from "../../components/messages/SandboxedHtmlViewer";
import { useCopyText } from "../../lib/copy-text";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { selectFilePreviewContents } from "../../lib/pages/file-preview-selection";
import { useObjectUrl } from "../../lib/pages/use-object-url";
import { useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** The artifact selected in the list, its version picker, and its rendered file. */
export function PreviewPane({
  artifactId,
  maximized,
  onToggleMaximize,
}: {
  artifactId: string;
  maximized: boolean;
  onToggleMaximize: () => void;
}) {
  const { t } = useLingui();
  const [copied, copy, copyFailed, resetCopy, copyFailedText] = useCopyText();
  const queries = useSpaceQueries();
  const versionsQuery = useQuery(
    queries.artifacts.listVersions.queryOptions({
      input: { familyId: artifactId },
    }),
  );
  const versions = versionsQuery.data ?? null;
  const [pickedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const selectedVersionId =
    pickedVersionId ??
    (versions ? (versions[0]?.id ?? artifactId) : versionsQuery.isError ? artifactId : null);
  const artifactQuery = useQuery(
    queries.artifacts.getById.queryOptions({
      input: selectedVersionId ? { artifactId: selectedVersionId } : skipToken,
    }),
  );
  const bytes = useMemo(
    () => (artifactQuery.data ? decodeArtifactBase64(artifactQuery.data.contentBase64) : null),
    [artifactQuery.data],
  );
  const state:
    | { status: "loading" }
    | { status: "ready"; artifact: Artifact; bytes: Uint8Array }
    | { status: "error"; message: string } =
    artifactQuery.data && bytes
      ? { status: "ready", artifact: artifactQuery.data, bytes }
      : artifactQuery.error
        ? {
            status: "error",
            message: errorText(artifactQuery.error, t`Could not load this artifact.`),
          }
        : { status: "loading" };

  return (
    <section
      aria-label={state.status === "ready" ? state.artifact.name : t`Preview`}
      onKeyDown={(event) =>
        selectFilePreviewContents(
          event,
          event.currentTarget.querySelector("[data-file-preview-body]"),
        )
      }
      className="flex min-w-0 flex-1 flex-col"
    >
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body-lg font-semibold">
            {state.status === "ready" ? state.artifact.name : null}
          </h2>
          {state.status === "ready" && state.artifact.description ? (
            <p className="truncate text-body-sm text-muted-foreground">
              {state.artifact.description}
            </p>
          ) : null}
        </div>
        {versions && versions.length > 1 && selectedVersionId ? (
          <OptionSelect
            aria-label={t`Version`}
            className="w-auto shrink-0 text-body-sm"
            value={selectedVersionId}
            options={versions.map((entry) => ({
              value: entry.id,
              label: `v${entry.version} (${formatRelativeTime(entry.createdAt)})`,
            }))}
            onValueChange={setSelectedVersionId}
          />
        ) : null}
        {state.status === "ready" ? (
          <>
            {["markdown", "text"].includes(artifactPreviewKind(state.artifact.mimeType)) ? (
              <IconTooltip label={copied ? t`Copied` : t`Copy ${state.artifact.name}`}>
                <Button
                  variant="outline"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label={copied ? t`Copied` : t`Copy ${state.artifact.name}`}
                  onClick={() => void copy(new TextDecoder("utf-8").decode(state.bytes))}
                >
                  {copied ? (
                    <Check size={15} strokeWidth={1.9} />
                  ) : (
                    <Copy size={15} strokeWidth={1.9} />
                  )}
                </Button>
              </IconTooltip>
            ) : null}
            <CopyTextFallback
              open={copyFailed}
              onOpenChange={resetCopy}
              text={copyFailedText}
              label={t`Copy ${state.artifact.name}`}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadArtifactBytes(state.artifact.name, state.artifact.mimeType, state.bytes)
              }
            >
              <Download className="me-1.5" size={15} strokeWidth={1.9} />
              <Trans>Download</Trans>
            </Button>
            <IconTooltip label={maximized ? t`Show list` : t`Maximize`}>
              <Button
                variant="outline"
                size="icon"
                aria-label={maximized ? t`Show list` : t`Maximize`}
                onClick={onToggleMaximize}
                className="text-muted-foreground"
              >
                {maximized ? (
                  <Minimize2 size={15} strokeWidth={1.9} />
                ) : (
                  <Maximize2 size={15} strokeWidth={1.9} />
                )}
              </Button>
            </IconTooltip>
          </>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 p-5">
        {state.status === "loading" ? (
          <div className="grid h-full place-items-center text-body text-muted-foreground/80">
            <Spinner aria-label={t`Loading…`} />
          </div>
        ) : state.status === "error" ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : (
          <div className="relative h-full overflow-hidden rounded-2xl border border-border">
            <ArtifactPreview artifact={state.artifact} bytes={state.bytes} />
            {state.artifact.mimeType === "text/html" ? (
              <div className="absolute bottom-3 end-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1.5 text-caption text-white">
                <Lock size={12} strokeWidth={2} />
                <span>
                  <Trans>Isolated preview: no access to your account</Trans>
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function ArtifactPreview({ artifact, bytes }: { artifact: Artifact; bytes: Uint8Array }) {
  switch (artifactPreviewKind(artifact.mimeType)) {
    case "html":
      return (
        <SandboxedHtmlViewer html={new TextDecoder("utf-8").decode(bytes)} title={artifact.name} />
      );
    case "markdown":
      return (
        <div className="h-full overflow-y-auto bg-background">
          <article
            data-file-preview-body
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus the file body for keyboard selection.
            tabIndex={0}
            className="mx-auto w-full max-w-[760px] px-8 py-10 text-body-lg leading-7 text-foreground"
          >
            <ChatMarkdown>{new TextDecoder("utf-8").decode(bytes)}</ChatMarkdown>
          </article>
        </div>
      );
    case "text":
      return (
        <div className="h-full overflow-auto bg-background">
          <pre
            data-file-preview-body
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus the file body for keyboard selection.
            tabIndex={0}
            className="px-8 py-10 font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground"
          >
            {new TextDecoder("utf-8").decode(bytes)}
          </pre>
        </div>
      );
    case "pdf":
      return <PdfViewer bytes={bytes} title={artifact.name} />;
    case "video":
      return <VideoPreview bytes={bytes} name={artifact.name} />;
    case "image":
      return <ImagePreview bytes={bytes} mimeType={artifact.mimeType} name={artifact.name} />;
    case "none":
      return (
        <div className="grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80">
          <Trans>Preview isn't available for this file type. Download it to view it.</Trans>
        </div>
      );
  }
}

function ImagePreview({
  bytes,
  mimeType,
  name,
}: {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}) {
  const url = useObjectUrl(bytes, mimeType);
  if (!url) return null;
  return (
    <div className="grid h-full place-items-center overflow-auto bg-muted/40 p-4">
      <img src={url} alt={name} className="max-h-full max-w-full rounded-lg shadow-sm" />
    </div>
  );
}
