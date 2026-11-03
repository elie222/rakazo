import type { CSSProperties, MouseEvent, ReactNode, RefObject } from "react";
import {
  Component,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HastNode } from "./table-utils";
import "./markdown.web.css";
import "./markdown-table.css";
import { droppedTableHtmlText } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import { CheckIcon, CopyIcon, GlobeIcon, ImageIcon } from "./icons";
import type { ChatMarkdownProps } from "./markdown";
import {
  closeUnterminatedFence,
  inlineMarkdownImageSrc,
  LinkFaviconsPausedContext,
  linkFaviconOrigin,
  linkLabel,
  markdownLinkDisplayParts,
  markdownLinkNeedsPrompt,
  markdownLinkSite,
  markdownMentionId,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "./markdown";
import { useMarkdownCopy } from "./markdown-copy";
import { useMarkdownLinkCopy, useMarkdownLinkTrust } from "./markdown-link-prompt";
import { MarkdownTable, MarkdownTableSourceContext } from "./markdown-table";
import { isMermaidFence, mermaidSvgImage } from "./mermaid";
import { useMermaidSvg } from "./mermaid.web";

function preserveSkippedTableText() {
  return (tree: HastNode) => {
    const walk = (node: HastNode, inTableCell = false) => {
      const insideCell = inTableCell || node.tagName === "th" || node.tagName === "td";
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (insideCell && child.type === "raw") {
          const value = droppedTableHtmlText(child.value ?? "");
          return value === null ? child : { type: "text", value };
        }
        walk(child, insideCell);
        return child;
      });
    };
    walk(tree);
  };
}

function CopyButton({ read, label }: { read: () => string; label: string }) {
  const copy = useMarkdownCopy();
  const resetTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(read())
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [read]);

  return (
    <button
      type="button"
      className="rk-chat-markdown-copy"
      onClick={handleCopy}
      aria-label={copied ? copy.copied : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CodeBlock({
  copyable,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & { copyable: boolean }) {
  const copy = useMarkdownCopy();
  const preRef = useRef<HTMLPreElement>(null);
  // The parser ends a fence's code with a newline the author didn't write.
  const readCode = useCallback(() => (preRef.current?.textContent ?? "").replace(/\n$/, ""), []);

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <pre {...props} ref={preRef} />
      {copyable ? <CopyButton read={readCode} label={copy.copyCode} /> : null}
    </div>
  );
}

/** Original markdown while streaming, before any display-only closing fence is appended. */
const StreamingSourceContext = createContext<string | undefined>(undefined);

function codeElement(node: MarkdownHast | undefined) {
  return node?.children?.find((child) => child.tagName === "code");
}

function codeText(code: MarkdownHast | undefined) {
  return (code?.children ?? []).map((child) => child.value ?? "").join("");
}

/** The source of a ```mermaid fence, or undefined for any other block. */
function mermaidFenceSource(node: MarkdownHast | undefined): string | undefined {
  const code = codeElement(node);
  const classNames = code?.properties?.className;
  const language = Array.isArray(classNames)
    ? classNames.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  if (typeof language !== "string" || !isMermaidFence(language.slice("language-".length))) {
    return undefined;
  }
  const source = codeText(code);
  return source.trim() ? source.trimEnd() : undefined;
}

function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const copy = useMarkdownCopy();
  const svg = useMermaidSvg(source);
  const readSource = useCallback(() => source, [source]);
  const image = svg ? mermaidSvgImage(svg) : undefined;
  // Rendering, or source Mermaid cannot draw: the code block keeps the content readable.
  if (!image) return fallback;
  return (
    <div className="rk-chat-markdown-pre-wrap">
      <figure className="rk-chat-markdown-diagram" data-testid="chat-diagram">
        {/* An image, not inline SVG: nothing in a diagram can script or style the page. */}
        <img
          src={image.src}
          width={image.width}
          height={image.height}
          alt={image.alt}
          style={{ "--rk-diagram-width": `${image.width}px` } as CSSProperties}
        />
      </figure>
      <CopyButton read={readSource} label={copy.copyDiagramSource} />
    </div>
  );
}

function MarkdownPre({
  node,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & { node?: MarkdownHast }) {
  const streamingSource = useContext(StreamingSourceContext);
  const diagram = mermaidFenceSource(node);
  // An empty fence has nothing to copy.
  const codeBlock = <CodeBlock {...props} copyable={/\S/.test(codeText(codeElement(node)))} />;
  if (diagram === undefined) return codeBlock;
  // Parser offsets identify the fence inside quotes and lists too. Inspect the original source,
  // since a display-only closing fence must never trigger a diagram render.
  if (streamingSource !== undefined) {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    const fence = start === undefined ? "" : streamingSource.slice(start, end);
    const opening = fence.match(/^(`{3,}|~{3,})/);
    const lastLine = fence.slice(fence.lastIndexOf("\n") + 1);
    const closing = lastLine.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (
      !fence.includes("\n") ||
      !opening?.[1] ||
      !closing?.[1] ||
      opening[1][0] !== closing[1][0] ||
      closing[1].length < opening[1].length
    ) {
      return codeBlock;
    }
  }
  return <MermaidDiagram source={diagram} fallback={codeBlock} />;
}

type EnclosingLink = false | "open" | "rejected";

const InsideLinkContext = createContext<EnclosingLink>(false);

const ConfirmLinkContext = createContext<(url: string) => void>(() => undefined);

function pageOrigin() {
  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : null;
}

function holdExternalLink(
  event: MouseEvent<HTMLAnchorElement>,
  request: (url: string) => void,
  trustedSites: readonly string[],
) {
  if (event.button !== 0 && event.button !== 1) return;
  const destination = event.currentTarget.href;
  if (!destination || !markdownLinkNeedsPrompt(destination, pageOrigin(), trustedSites)) return;
  event.preventDefault();
  request(destination);
}

function ExternalLinkUrl({ url }: { url: string }) {
  const parts = markdownLinkDisplayParts(url);
  if (!parts) return url;
  return (
    <>
      {parts.before}
      <strong className="font-semibold">{parts.host}</strong>
      {parts.after}
    </>
  );
}

function openExternalLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function ExternalLinkAlert({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copy = useMarkdownLinkCopy();
  const { trust } = useMarkdownLinkTrust();
  const site = trust ? markdownLinkSite(url) : undefined;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription className="break-all text-left text-foreground">
            <ExternalLinkUrl url={url} />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
          {trust && site ? (
            <AlertDialogAction
              variant="outline"
              className="h-auto min-h-8 shrink whitespace-normal break-all"
              onClick={() => {
                openExternalLink(url);
                trust(url);
                onDismiss();
              }}
            >
              {copy.alwaysOpen(site)}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction
            onClick={() => {
              openExternalLink(url);
              onDismiss();
            }}
          >
            {copy.open}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useExternalLinkConfirm() {
  const [url, setUrl] = useState<string | null>(null);
  const request = useCallback((destination: string) => {
    setUrl(destination);
  }, []);
  const dialog = url ? <ExternalLinkAlert url={url} onDismiss={() => setUrl(null)} /> : null;
  return { request, dialog };
}

/** Sends clicks on links drawn inside an element, such as a chart's SVG, through the prompt. */
export function useLinkPrompt(container: RefObject<HTMLElement | null>): ReactNode {
  const { request, dialog } = useExternalLinkConfirm();
  const { sites } = useMarkdownLinkTrust();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const hold = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      const href = anchor && element.contains(anchor) ? anchor.getAttribute("href") : null;
      if (!href) return;
      event.preventDefault();
      const url = new URL(href, document.baseURI).href;
      if (markdownLinkNeedsPrompt(url, pageOrigin(), sites)) request(url);
      else openExternalLink(url);
    };
    element.addEventListener("click", hold);
    element.addEventListener("auxclick", hold);
    return () => {
      element.removeEventListener("click", hold);
      element.removeEventListener("auxclick", hold);
    };
  }, [container, request, sites]);
  return dialog;
}

function ConfirmableAnchor({ href, ...props }: React.ComponentPropsWithoutRef<"a">) {
  const request = useContext(ConfirmLinkContext);
  const { sites } = useMarkdownLinkTrust();
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => holdExternalLink(event, request, sites)}
      onAuxClick={(event) => holdExternalLink(event, request, sites)}
    />
  );
}

type MarkdownHast = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHast[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function hastString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function soleRemoteImage(node: MarkdownHast | undefined):
  | {
      href: string;
      host: string;
      alt?: string;
      title?: string;
    }
  | undefined {
  const parts = (node?.children ?? []).filter((child) => {
    if (child.type === "text") return Boolean(child.value?.trim());
    return child.type === "element";
  });
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.tagName !== "img") return undefined;
  const remote = remoteMarkdownImage(hastString(only.properties?.src) ?? "");
  if (!remote) return undefined;
  return {
    ...remote,
    alt: hastString(only.properties?.alt),
    title: hastString(only.properties?.title),
  };
}

function RemoteImageButton({
  image,
  alt,
  title,
  onLoad,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      className="rk-chat-markdown-image"
      title={title}
      onClick={() => {
        markRemoteImageLoaded(image.href);
        onLoad();
      }}
    >
      <ImageIcon />
      {alt ? <span>{alt}</span> : null}
      <span className="rk-chat-markdown-image-host">{image.host}</span>
    </button>
  );
}

function MarkdownImage({ src = "", alt, title }: { src?: string; alt?: string; title?: string }) {
  const enclosingLink = useContext(InsideLinkContext);
  const loadRemote = useContext(RemoteImagesContext);
  const remote = remoteMarkdownImage(src);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  const rejectedLink = enclosingLink === "rejected";
  if (inlineMarkdownImageSrc(src)) {
    return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  }
  if (remote && remoteImageRenders(remote.href, loadRemote, rejectedLink)) {
    return (
      <img
        src={remote.href}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (!remote || enclosingLink !== false) return alt || remote?.host || src;
  return (
    <RemoteImageButton
      image={remote}
      alt={alt}
      title={title}
      onLoad={() => setRevision((revision) => revision + 1)}
    />
  );
}

function LinkedRemoteImage({
  href,
  image,
  alt,
  title,
}: {
  href: string;
  image: { href: string; host: string };
  alt?: string;
  title?: string;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <ConfirmableAnchor href={href}>
        <img
          src={image.href}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </ConfirmableAnchor>
    );
  }
  return (
    <span className="rk-chat-markdown-linked-image">
      <RemoteImageButton
        image={image}
        alt={alt}
        title={title}
        onLoad={() => setRevision((revision) => revision + 1)}
      />
      <ConfirmableAnchor href={href}>{linkHost(href)}</ConfirmableAnchor>
    </span>
  );
}

/** The label when it is plain text, the only kind that can be a bare URL. */
function hastText(node: MarkdownHast | undefined): string | undefined {
  const children = node?.children ?? [];
  if (!children.every((child) => child.type === "text")) return undefined;
  return children.map((child) => child.value ?? "").join("");
}

function hastHasImage(node: MarkdownHast | undefined): boolean {
  return (node?.children ?? []).some((child) => child.tagName === "img" || hastHasImage(child));
}

function LinkFavicon({ href }: { href: string }) {
  const { icon, unusable } = useLinkFavicon(href);
  return (
    <span
      aria-hidden="true"
      className={icon ? "rk-chat-link-tile rk-chat-link-tile-icon" : "rk-chat-link-tile"}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          onLoad={(event) => {
            // A 1×1 image is a tracking pixel, not an icon.
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 || image.naturalHeight <= 1) unusable();
          }}
          onError={unusable}
        />
      ) : (
        <GlobeIcon />
      )}
    </span>
  );
}

/** A link to a website, drawn with its site icon before the label. */
function WebsiteLink({
  href,
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string; children: ReactNode }) {
  return (
    <ConfirmableAnchor
      {...props}
      href={href}
      className={className ? `rk-chat-link ${className}` : "rk-chat-link"}
    >
      <LinkFavicon href={href} />
      {/* bdi: direction characters in a label cannot reorder the text around the link. */}
      <bdi className="rk-chat-link-label">{children}</bdi>
    </ConfirmableAnchor>
  );
}

function MarkdownAnchor({
  node,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { node?: MarkdownHast }) {
  const loadRemote = useContext(RemoteImagesContext);
  const renderMention = useContext(MentionContext);
  const href = typeof props.href === "string" ? props.href : "";
  const mentionId = markdownMentionId(href);
  if (mentionId) {
    const name = hastText(node) ?? "";
    return renderMention?.(mentionId, name) ?? <span>{props.children}</span>;
  }
  const image = href ? soleRemoteImage(node) : undefined;
  if (image && !remoteImageRenders(image.href, loadRemote, false)) {
    return <LinkedRemoteImage href={href} image={image} alt={image.alt} title={image.title} />;
  }
  // urlTransform blanks unsafe URLs. Keep their text without a link that opens the app again.
  const opens = Boolean(props.href);
  const text = hastText(node);
  const link =
    opens && linkFaviconOrigin(href) && !hastHasImage(node) ? (
      <WebsiteLink {...props} href={href}>
        {text === undefined ? props.children : linkLabel(text, href)}
      </WebsiteLink>
    ) : opens ? (
      <ConfirmableAnchor {...props} />
    ) : (
      <span>{props.children}</span>
    );
  return (
    <InsideLinkContext.Provider value={opens ? "open" : "rejected"}>
      {link}
    </InsideLinkContext.Provider>
  );
}

const MentionContext = createContext<ChatMarkdownProps["renderMention"]>(undefined);

const components: Components = {
  a: MarkdownAnchor,
  img({ node: _node, src, alt, title }) {
    return (
      <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
    );
  },
  pre: MarkdownPre,
  table({ node, children, ...props }) {
    return (
      <MarkdownTable node={node} tableProps={props}>
        {children}
      </MarkdownTable>
    );
  },
};

type PlainTextState = { text: string; failed: boolean };

/** The parser recurses, so a pathological message can exhaust the stack; show it as plain text. */
class PlainTextOnFailure extends Component<{ text: string; children: ReactNode }, PlainTextState> {
  override state = { text: this.props.text, failed: false };

  static getDerivedStateFromProps(props: { text: string }, state: PlainTextState) {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <p className="whitespace-pre-wrap">{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}

export function LinkifiedText({ children }: { children: string }) {
  const { request, dialog } = useExternalLinkConfirm();
  return (
    <ConfirmLinkContext.Provider value={request}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : linkFaviconOrigin(part.href) ? (
          <WebsiteLink key={index} href={part.href} className="rk-chat-link-in-bubble">
            {linkLabel(part.value, part.href)}
          </WebsiteLink>
        ) : (
          <ConfirmableAnchor key={index} href={part.href} className="underline">
            {part.value}
          </ConfirmableAnchor>
        ),
      )}
      {dialog}
    </ConfirmLinkContext.Provider>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  renderMention,
}: ChatMarkdownProps) {
  const { request, dialog } = useExternalLinkConfirm();
  const source = streaming ? closeUnterminatedFence(children) : children;

  return (
    <ConfirmLinkContext.Provider value={request}>
      <MentionContext.Provider value={renderMention}>
        <div
          className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}
        >
          <LinkFaviconsPausedContext.Provider value={streaming}>
            <StreamingSourceContext.Provider value={streaming ? children : undefined}>
              <MarkdownTableSourceContext.Provider value={source}>
                <PlainTextOnFailure text={children}>
                  <ReactMarkdown
                    components={components}
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[preserveSkippedTableText]}
                    skipHtml
                    // MarkdownImage decides what an image source may do, so it receives the source as written.
                    urlTransform={(url, key) =>
                      key === "src" || markdownMentionId(url)
                        ? url
                        : (sanitizeMarkdownUrl(url, true) ?? "")
                    }
                  >
                    {source}
                  </ReactMarkdown>
                </PlainTextOnFailure>
              </MarkdownTableSourceContext.Provider>
            </StreamingSourceContext.Provider>
          </LinkFaviconsPausedContext.Provider>
          {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
        </div>
      </MentionContext.Provider>
      {dialog}
    </ConfirmLinkContext.Provider>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export {
  LinkFaviconsContext,
  RemoteImagesContext,
  useLinkFavicon,
  withBlockMentions,
} from "./markdown";
export type { MarkdownCopy } from "./markdown-copy";
export { defaultMarkdownCopy, MarkdownCopyProvider } from "./markdown-copy";
export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
