import type { MouseEvent, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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
  markdownLinkRequiresConfirmation,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "./markdown";
import { useMarkdownLinkCopy } from "./markdown-link-prompt";
import { MarkdownTable, MarkdownTableSourceContext } from "./markdown-table";

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

function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <pre {...props} ref={preRef} />
      <button
        type="button"
        className="rk-chat-markdown-copy"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

type EnclosingLink = false | "open" | "rejected";

const InsideLinkContext = createContext<EnclosingLink>(false);

const ConfirmLinkContext = createContext<(url: string) => void>(() => undefined);

function pageOrigin() {
  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : null;
}

function holdExternalLink(event: MouseEvent<HTMLAnchorElement>, request: (url: string) => void) {
  if (event.button !== 0 && event.button !== 1) return;
  const destination = event.currentTarget.href;
  if (!destination || !markdownLinkRequiresConfirmation(destination, pageOrigin())) return;
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

function ExternalLinkAlert({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copy = useMarkdownLinkCopy();
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
          <AlertDialogAction
            onClick={() => {
              window.open(url, "_blank", "noopener,noreferrer");
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

function ConfirmableAnchor({ href, ...props }: React.ComponentPropsWithoutRef<"a">) {
  const request = useContext(ConfirmLinkContext);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => holdExternalLink(event, request)}
      onAuxClick={(event) => holdExternalLink(event, request)}
    />
  );
}

type MarkdownHast = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHast[];
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
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string; children: ReactNode }) {
  return (
    <ConfirmableAnchor {...props} href={href} className="rk-chat-link">
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
  const href = typeof props.href === "string" ? props.href : "";
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

const components: Components = {
  a: MarkdownAnchor,
  img({ node: _node, src, alt, title }) {
    return (
      <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
    );
  },
  pre({ node: _node, ...props }) {
    return <CodeBlock {...props} />;
  },
  table({ node, children, ...props }) {
    return (
      <MarkdownTable node={node} tableProps={props}>
        {children}
      </MarkdownTable>
    );
  },
};

export function LinkifiedText({ children }: { children: string }) {
  const { request, dialog } = useExternalLinkConfirm();
  return (
    <ConfirmLinkContext.Provider value={request}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : linkFaviconOrigin(part.href) ? (
          <WebsiteLink key={index} href={part.href}>
            {linkLabel(part.value, part.href)}
          </WebsiteLink>
        ) : (
          <ConfirmableAnchor key={index} href={part.href} className="text-link underline">
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
}: ChatMarkdownProps) {
  const { request, dialog } = useExternalLinkConfirm();
  const source = streaming ? closeUnterminatedFence(children) : children;

  return (
    <ConfirmLinkContext.Provider value={request}>
      <div
        className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}
      >
        <LinkFaviconsPausedContext.Provider value={streaming}>
          <MarkdownTableSourceContext.Provider value={source}>
            <ReactMarkdown
              components={components}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[preserveSkippedTableText]}
              skipHtml
              // MarkdownImage decides what an image source may do, so it receives the source as written.
              urlTransform={(url, key) =>
                key === "src" ? url : (sanitizeMarkdownUrl(url, true) ?? "")
              }
            >
              {source}
            </ReactMarkdown>
          </MarkdownTableSourceContext.Provider>
        </LinkFaviconsPausedContext.Provider>
        {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
      </div>
      {dialog}
    </ConfirmLinkContext.Provider>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export { LinkFaviconsContext, RemoteImagesContext } from "./markdown";

export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
