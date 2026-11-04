import { useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import { findTextRanges, sameStart } from "./chat-find";

const MATCHES = "rk-find";
const CURRENT = "rk-find-current";
const REFRESH_MS = 250;

function reveal(range: Range) {
  range.startContainer.parentElement?.scrollIntoView({ block: "center" });
}

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
  scope,
  inputRef,
  onClose,
}: {
  /** The chat column. The transcript inside it remounts when a chat's history loads. */
  scope: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ ranges: Range[]; index: number }>({ ranges: [], index: 0 });
  const { ranges } = found;

  // Streaming replies and older history change the transcript while the bar is open. A new
  // query jumps to its first match; a refresh keeps the selected match where it is.
  useEffect(() => {
    const transcript = scope.current;
    if (!transcript) {
      setFound({ ranges: [], index: 0 });
      return;
    }
    const first = findTextRanges(transcript, query);
    setFound({ ranges: first, index: 0 });
    if (first[0]) reveal(first[0]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer = undefined;
      const next = findTextRanges(transcript, query);
      setFound((previous) => {
        const selected = previous.ranges[previous.index];
        const kept = selected ? next.findIndex((range) => sameStart(range, selected)) : -1;
        return {
          ranges: next,
          index: kept === -1 ? Math.min(previous.index, next.length - 1) : kept,
        };
      });
    };
    // A streaming reply changes the transcript many times a second; rescanning a few times a
    // second keeps the count current without searching on every token.
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(refresh, REFRESH_MS);
    });
    observer.observe(transcript, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [query, scope]);

  const current = ranges.length > 0 ? Math.max(0, Math.min(found.index, ranges.length - 1)) : -1;
  const currentRange = current === -1 ? undefined : ranges[current];

  useLayoutEffect(() => setHighlights(ranges, currentRange), [ranges, currentRange]);
  useEffect(() => clearHighlights, []);

  function step(by: 1 | -1) {
    if (ranges.length === 0) return;
    const index = (current + by + ranges.length) % ranges.length;
    setFound({ ranges, index });
    const range = ranges[index];
    if (range) reveal(range);
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
        onChange={(event) => setQuery(event.target.value)}
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
