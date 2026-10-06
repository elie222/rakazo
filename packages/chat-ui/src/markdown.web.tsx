import { createContext, memo, useCallback, useContext, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HastNode } from "./table-utils";
import "./markdown.web.css";
import "./markdown-table.css";
import { droppedTableHtmlText } from "@rakazo/contracts";
import { CheckIcon, CopyIcon } from "./icons";
import type { ChatMarkdownProps } from "./markdown";
import {
  closeUnterminatedFence,
  inlineMarkdownImageSrc,
  plainTextLinkParts,
  sanitizeMarkdownImageUrl,
  sanitizeMarkdownUrl,
} from "./markdown";
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

const InsideLinkContext = createContext(false);

function MarkdownImage({ src = "", alt, title }: { src?: string; alt?: string; title?: string }) {
  const insideLink = useContext(InsideLinkContext);
  if (inlineMarkdownImageSrc(src)) {
    return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  }
  const label = alt || src;
  const href = sanitizeMarkdownImageUrl(src);
  // Inside a link the label joins the link text, so a badge still opens its link target.
  if (!href || insideLink) return label;
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

const components: Components = {
  a({ node: _node, ...props }) {
    // urlTransform blanks unsafe URLs. Keep their text without a link that opens the app again.
    const link = props.href ? (
      <a {...props} target="_blank" rel="noreferrer noopener" />
    ) : (
      <span>{props.children}</span>
    );
    return <InsideLinkContext.Provider value={true}>{link}</InsideLinkContext.Provider>;
  },
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
  return plainTextLinkParts(children).map((part, index) =>
    part.type === "text" ? (
      part.value
    ) : (
      <a
        key={index}
        href={part.href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-link underline"
      >
        {part.value}
      </a>
    ),
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
}: ChatMarkdownProps) {
  const source = streaming ? closeUnterminatedFence(children) : children;

  return (
    <div className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}>
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
      {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
    </div>
  );
});

export type { ChatMarkdownProps } from "./markdown";
