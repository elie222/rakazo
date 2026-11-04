import { useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { findTextRanges } from "./chat-find";

const MATCHES = "rk-find";
const CURRENT = "rk-find-current";

function setHighlights(all: Range[], current: Range | undefined) {
  // Painting needs the CSS Custom Highlight API; without it Enter still scrolls to each match.
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    return;
  }
  CSS.highlights.set(MATCHES, new Highlight(...all));
  if (current) CSS.highlights.set(CURRENT, new Highlight(current));
  else CSS.highlights.delete(CURRENT);
}

function clearHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(MATCHES);
  CSS.highlights.delete(CURRENT);
}

/** Finds text in the open chat's loaded messages, the desktop app's Cmd/Ctrl+F. */
export function ChatFindBar({
  inputRef,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const scrollOnChange = useRef(true);

  // Streaming replies and older history change the transcript while the bar is open.
  useEffect(() => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    if (!transcript) {
      setRanges([]);
      return;
    }
    let frame = 0;
    const search = () => {
      frame = 0;
      setRanges(findTextRanges(transcript, query));
    };
    search();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(search);
    });
    observer.observe(transcript, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [query]);

  const current = ranges.length > 0 ? Math.min(index, ranges.length - 1) : -1;
  const currentRange = current === -1 ? undefined : ranges[current];

  useLayoutEffect(() => {
    setHighlights(ranges, currentRange);
    if (!currentRange || !scrollOnChange.current) return;
    scrollOnChange.current = false;
    currentRange.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, [ranges, currentRange]);

  useEffect(() => clearHighlights, []);

  function step(by: 1 | -1) {
    if (ranges.length === 0) return;
    scrollOnChange.current = true;
    setIndex((current + by + ranges.length) % ranges.length);
  }

  return (
    <search
      className="flex items-center gap-1 rounded-xl border border-border bg-popover p-1 shadow-md"
      data-testid="chat-find"
    >
      <Input
        ref={inputRef}
        type="search"
        aria-label={t`Find in chat`}
        placeholder={t`Find in chat`}
        value={query}
        autoFocus
        onChange={(event) => {
          scrollOnChange.current = true;
          setIndex(0);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-8 w-56 border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
      {query.trim() ? (
        <span
          className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {current + 1}/{ranges.length}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Previous match`}
        disabled={ranges.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp size={16} strokeWidth={1.8} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Next match`}
        disabled={ranges.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDown size={16} strokeWidth={1.8} />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={onClose}>
        <X size={16} strokeWidth={1.8} />
      </Button>
    </search>
  );
}
