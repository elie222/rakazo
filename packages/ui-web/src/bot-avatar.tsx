import { cn } from "./lib/utils.js";

export function BotAvatar({
  color,
  size = 38,
  thinking = false,
  className,
}: {
  color: string;
  size?: number;
  thinking?: boolean;
  className?: string;
}) {
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.4);
  const dot = Math.max(3, Math.round(size * 0.1));
  const radius = Math.max(4, Math.round(size * 0.24));
  return (
    <div
      className={cn("flex items-center justify-center", thinking && "rk-avatar-think", className)}
      style={{
        width: size,
        height: size,
        background: color,
        flex: "none",
        borderRadius: radius,
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.55),
          background: "rgba(12,12,14,0.78)",
          gap: Math.max(4, Math.round(size * 0.13)),
        }}
      >
        <span className="rk-avatar-eye rounded-full bg-white" style={{ width: dot, height: dot }} />
        <span className="rk-avatar-eye rounded-full bg-white" style={{ width: dot, height: dot }} />
      </div>
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-[#16161A]">
        <span className="h-4 w-[7px] rounded-full bg-[#F7F7F4]" />
        <span className="h-4 w-[7px] rounded-full bg-[#F7F7F4]" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-[#1B1B1E]">
        Rakazo
      </span>
    </div>
  );
}
