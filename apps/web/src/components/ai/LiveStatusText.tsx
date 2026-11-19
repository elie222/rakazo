import { cn } from "@rakazo/ui-web";

export function LiveStatusText({ text, className }: { text: string; className?: string }) {
  return (
    <span
      key={text}
      dir="auto"
      className={cn(
        "block min-w-0 truncate animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none",
        className,
      )}
    >
      <span className="text-shimmer">{text}</span>
    </span>
  );
}
