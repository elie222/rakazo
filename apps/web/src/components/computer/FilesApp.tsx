import { useLingui } from "@lingui/react/macro";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft, Download, File, Folder, Upload } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import {
  basename,
  type ComputerFileEntry,
  formatSize,
  parentPath,
  sortEntries,
  subscribeComputerCommands,
} from "../../lib/computer-workspace";
import { isFileDrag, readFileAsBase64 } from "../../lib/pending-attachments";
import { rpc } from "../../lib/rpc";
import { useObjectUrl } from "../../lib/use-object-url";

type Entry = ComputerFileEntry;
type Preview =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "image"; bytes: Uint8Array; mimeType: string };

const FILES_REFRESH_MS = 3_000;

const IMAGE_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Browse the bot's workspace. Download needs a running computer; upload needs control. */
export function FilesApp({
  botId,
  running,
  canUpload,
  visible,
}: {
  botId: string;
  running: boolean;
  canUpload: boolean;
  /** Refresh only while the window is on screen. */
  visible: boolean;
}) {
  const { t } = useLingui();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(
    async (target: string) => {
      const generation = ++loadGeneration.current;
      setError(null);
      try {
        const listed = await rpc.computer.files({ botId, path: target });
        if (generation !== loadGeneration.current) return;
        setEntries(sortEntries(listed));
        setPath(target);
        setPreview(null);
      } catch (cause) {
        if (generation !== loadGeneration.current) return;
        setError(errorMessage(cause, t`Could not list files`));
      }
    },
    [botId, t],
  );

  useEffect(() => {
    setPath("");
    setEntries(null);
    setPreview(null);
    setError(null);
    void load("");
  }, [load]);

  useEffect(() => {
    if (!visible || preview) return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const generation = loadGeneration.current;
      const listed = await rpc.computer.files({ botId, path }).catch(() => null);
      if (cancelled || !listed || generation !== loadGeneration.current) return;
      const next = sortEntries(listed);
      setEntries((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    const timer = window.setInterval(() => void refresh(), FILES_REFRESH_MS);
    const unsubscribe = subscribeComputerCommands((eventBotId, command) => {
      if (eventBotId === botId && command.status === "done") void refresh();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [botId, path, preview, visible]);

  async function open(entry: Entry) {
    if (entry.kind === "dir") return load(entry.path);
    setError(null);
    try {
      const mimeType = IMAGE_TYPES[extension(entry.path)];
      if (mimeType && running) {
        const file = await rpc.computer.downloadFile({ botId, path: entry.path });
        setPreview({
          path: entry.path,
          kind: "image",
          bytes: decodeArtifactBase64(file.contentBase64),
          mimeType,
        });
      } else {
        const file = await rpc.computer.readFile({ botId, path: entry.path });
        setPreview({ path: entry.path, kind: "text", content: file.content });
      }
    } catch (cause) {
      setError(errorMessage(cause, t`Could not open file`));
    }
  }

  async function download(target: string) {
    setError(null);
    try {
      const file = await rpc.computer.downloadFile({ botId, path: target });
      downloadArtifactBytes(
        basename(target),
        IMAGE_TYPES[extension(target)] ?? "application/octet-stream",
        decodeArtifactBase64(file.contentBase64),
      );
    } catch (cause) {
      setError(errorMessage(cause, t`Could not download file`));
    }
  }

  async function upload(files: FileList | File[]) {
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(t`File is too large to upload.`);
        }
        await rpc.computer.uploadFile({
          botId,
          path: path ? `${path}/${file.name}` : file.name,
          contentBase64: await readFileAsBase64(file),
        });
      }
      await load(path);
    } catch (cause) {
      setError(errorMessage(cause, t`Could not upload file`));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent) {
    if (!canUpload || !event.ctrlKey || !isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    void upload(event.dataTransfer.files);
  }

  const location = preview?.path ?? path;
  return (
    <fieldset
      className="m-0 flex h-full min-h-0 min-w-0 flex-col border-0 bg-background p-0 text-[13px]"
      data-testid="computer-files"
      onDragOver={(event) => {
        if (canUpload && event.ctrlKey && isFileDrag(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Back`}
          disabled={!preview && !path}
          onClick={() => (preview ? setPreview(null) : void load(parentPath(path)))}
        >
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
          ~/{location}
        </span>
        {preview && running ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Download`}
            onClick={() => void download(preview.path)}
          >
            <Download />
          </Button>
        ) : null}
        {!preview && canUpload ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Upload`}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload />
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void upload(event.target.files);
                event.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="px-3 py-2 text-destructive">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {preview ? (
          <FilePreview preview={preview} />
        ) : (
          <ul>
            {entries?.map((entry) => (
              <li key={entry.path} className="group flex items-center hover:bg-accent">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-foreground"
                  onClick={() => void open(entry)}
                >
                  {entry.kind === "dir" ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate" dir="auto">
                    {basename(entry.path)}
                  </span>
                  {entry.kind === "file" ? (
                    <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                      {formatSize(entry.size)}
                    </span>
                  ) : null}
                </button>
                {entry.kind === "file" && running ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t`Download ${basename(entry.path)}`}
                    onClick={() => void download(entry.path)}
                  >
                    <Download />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </fieldset>
  );
}

function FilePreview({ preview }: { preview: Preview }) {
  if (preview.kind === "text") {
    return (
      <pre className="p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
        {preview.content}
      </pre>
    );
  }
  return <ImagePreview preview={preview} />;
}

function ImagePreview({ preview }: { preview: Extract<Preview, { kind: "image" }> }) {
  const url = useObjectUrl(preview.bytes, preview.mimeType);
  return url ? (
    <img src={url} alt={basename(preview.path)} className="mx-auto max-h-full max-w-full p-3" />
  ) : null;
}

function extension(path: string) {
  const name = basename(path);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
