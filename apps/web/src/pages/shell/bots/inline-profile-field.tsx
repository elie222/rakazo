import { Input } from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
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
    <div className="min-w-0 flex-1">
      <span className="block text-body-sm text-muted-foreground">{label}</span>
      <Input
        autoFocus
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        className={`mt-0.5 border-transparent bg-transparent p-0 shadow-none ${className}`}
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
    </div>
  ) : (
    <div className="min-w-0 flex-1">
      <span className="block text-body-sm text-muted-foreground">{label}</span>
      <button
        type="button"
        aria-label={editLabel}
        title={editLabel}
        className={`group -mx-1.5 flex w-full min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${className}`}
        onClick={() => {
          cancelled.current = false;
          setDraft(value);
          setEditing(true);
        }}
      >
        <span className="min-w-0 truncate">{value}</span>
        <Pencil
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}
