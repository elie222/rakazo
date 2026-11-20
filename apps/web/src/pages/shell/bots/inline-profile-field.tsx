import { Input } from "@rakazo/ui-web";
import { useRef, useState } from "react";

/** A profile value edited in place: commits on Enter or blur, cancels on Escape. */
export function InlineProfileField({
  label,
  editLabel,
  value,
  maxLength,
  className,
  onCommit,
}: {
  label: string;
  editLabel: string;
  value: string;
  maxLength: number;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  function commit() {
    if (cancelled.current) return;
    setEditing(false);
    if (draft.trim() !== value.trim()) onCommit(draft);
  }
  return editing ? (
    <Input
      autoFocus
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      className={`h-auto border-transparent bg-transparent p-0 text-center shadow-none ${className}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Escape") event.stopPropagation();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          cancelled.current = true;
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      aria-label={editLabel}
      className={`min-w-0 max-w-full cursor-text break-words rounded px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      onClick={() => {
        cancelled.current = false;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </button>
  );
}
