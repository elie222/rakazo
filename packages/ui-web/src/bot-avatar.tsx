import { cn } from "./lib/utils.js";

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  working?: boolean;
  className?: string;
}

export function BotAvatar({
  color,
  size = 38,
  status,
  working,
  className,
}: BotAvatarProps) {
  const isWorking = working || status === "running";
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(4, Math.round(size * 0.14));
  const eyeH = Math.max(7, Math.round(size * 0.22));
  const eyeRadius = Math.max(2, Math.round(eyeW * 0.5));
  const eyeGap = Math.max(3, Math.round(size * 0.10));

  // Compute a deterministic personality hash per bot color/avatar
  const seed = hashString(color || "#8B5CF6");
  const variant = seed % 4;
  const idleDuration = (4.2 + ((seed * 7) % 28) / 10).toFixed(2);
  const idleDelay = (-(((seed * 13) % 45) / 10)).toFixed(2);

  return (
    <div
      className={cn("rakazo-bot-avatar group relative flex items-center justify-center rounded-full select-none", className)}
      style={{
        width: size,
        height: size,
        flex: "none",
        background: `radial-gradient(circle at 35% 26%, ${lightenColor(color, 35)}, ${color} 55%, ${darkenColor(color, 40)} 100%)`,
        boxShadow: isWorking
          ? `0 0 0 2px rgba(255,255,255,0.25), 0 0 ${Math.round(size * 0.45)}px ${color}, inset 0 1px 2px rgba(255,255,255,0.6)`
          : `0 2px ${Math.max(4, Math.round(size * 0.15))}px rgba(0,0,0,0.4), inset 0 1px 1.5px rgba(255,255,255,0.4)`,
      }}
    >
      <style>{AVATAR_KEYFRAMES}</style>

      {/* Vivid Spinning Orbital Ring when working */}
      {isWorking ? (
        <svg
          className="absolute pointer-events-none"
          style={{
            inset: -4,
            width: size + 8,
            height: size + 8,
            animation: "rakazo-avatar-spin 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite",
            filter: `drop-shadow(0 0 6px ${color}) drop-shadow(0 0 10px #ffffff)`,
          }}
          viewBox="0 0 48 48"
          fill="none"
        >
          <circle
            cx="24"
            cy="24"
            r="22"
            stroke="url(#spin-grad)"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeDasharray="45 80"
          />
          <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
          <defs>
            <linearGradient id="spin-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="60%" stopColor={color} stopOpacity="0.9" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      ) : null}

      {/* Dark glossy visor screen */}
      <div
        className="relative flex items-center justify-center overflow-hidden transition-transform duration-200 group-hover:scale-[1.04]"
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.52),
          background: "linear-gradient(180deg, #101014 0%, #030305 100%)",
          boxShadow: "inset 0 1.5px 3px rgba(0,0,0,0.95), 0 1px 1px rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        {/* Subtle glass gloss highlight behind eyes */}
        <div
          className="absolute top-0 inset-x-0 h-[40%] pointer-events-none rounded-t-full"
          style={{
            background: "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.01) 100%)",
          }}
        />

        {/* Animated glowing eyes with asynchronous personality movements */}
        <div
          className="relative z-10 flex items-center justify-center"
          style={{
            gap: eyeGap,
            animation: isWorking
              ? "rakazo-eyes-working 1.4s ease-in-out infinite"
              : `rakazo-eyes-idle-${variant} ${idleDuration}s cubic-bezier(0.4, 0, 0.2, 1) ${idleDelay}s infinite`,
          }}
        >
          <span
            className="block bg-white"
            style={{
              width: eyeW,
              height: eyeH,
              borderRadius: eyeRadius,
              backgroundColor: "#FFFFFF",
              boxShadow: `0 0 4px #FFFFFF, 0 0 8px #FFFFFF, 0 0 14px ${lightenColor(color, 20)}`,
            }}
          />
          <span
            className="block bg-white"
            style={{
              width: eyeW,
              height: eyeH,
              borderRadius: eyeRadius,
              backgroundColor: "#FFFFFF",
              boxShadow: `0 0 4px #FFFFFF, 0 0 8px #FFFFFF, 0 0 14px ${lightenColor(color, 20)}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function lightenColor(hex: string, percent: number): string {
  return adjustColor(hex, percent);
}

function darkenColor(hex: string, percent: number): string {
  return adjustColor(hex, -percent);
}

function adjustColor(hex: string, percent: number): string {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6 && clean.length !== 3) return hex;
  const num = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  if (Number.isNaN(num)) return hex;
  let r = (num >> 16) + Math.round((255 * percent) / 100);
  let g = ((num >> 8) & 0x00ff) + Math.round((255 * percent) / 100);
  let b = (num & 0x0000ff) + Math.round((255 * percent) / 100);
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

const AVATAR_KEYFRAMES = `
@keyframes rakazo-avatar-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Variant 0: Looks right first, pauses, crisp blink, looks left */
@keyframes rakazo-eyes-idle-0 {
  0%, 32%, 100% {
    transform: translate(0, 0) scaleY(1);
  }
  35% {
    transform: translate(0, 0) scaleY(0.08);
  }
  38% {
    transform: translate(0, 0) scaleY(1);
  }
  48%, 62% {
    transform: translate(3px, -0.5px) scaleY(1);
  }
  70%, 84% {
    transform: translate(-2.5px, 0.5px) scaleY(1);
  }
  89% {
    transform: translate(0, 0) scaleY(0.12);
  }
  91% {
    transform: translate(0, 0) scaleY(1);
  }
}

/* Variant 1: Looks left-up first, soft double-blink, glances right */
@keyframes rakazo-eyes-idle-1 {
  0%, 25%, 100% {
    transform: translate(0, 0) scaleY(1);
  }
  32%, 48% {
    transform: translate(-3px, -1px) scaleY(1);
  }
  54% {
    transform: translate(0, 0) scaleY(0.08);
  }
  56% {
    transform: translate(0, 0) scaleY(1);
  }
  59% {
    transform: translate(0, 0) scaleY(0.08);
  }
  61% {
    transform: translate(0, 0) scaleY(1);
  }
  68%, 82% {
    transform: translate(2.5px, 0.5px) scaleY(1);
  }
}

/* Variant 2: Inquisitive glance up, smooth recenter, quick blink, looks right */
@keyframes rakazo-eyes-idle-2 {
  0%, 28%, 100% {
    transform: translate(0, 0) scaleY(1);
  }
  36%, 52% {
    transform: translate(0.5px, -1.8px) scaleY(1.05);
  }
  58% {
    transform: translate(0, 0) scaleY(0.08);
  }
  60% {
    transform: translate(0, 0) scaleY(1);
  }
  68%, 85% {
    transform: translate(3px, 0) scaleY(1);
  }
  92% {
    transform: translate(0, 0) scaleY(0.1);
  }
  94% {
    transform: translate(0, 0) scaleY(1);
  }
}

/* Variant 3: Looks down-left, subtle double blink, glances right-up */
@keyframes rakazo-eyes-idle-3 {
  0%, 24%, 100% {
    transform: translate(0, 0) scaleY(1);
  }
  30%, 46% {
    transform: translate(-2.5px, 1.2px) scaleY(0.95);
  }
  52% {
    transform: translate(0, 0) scaleY(0.08);
  }
  54% {
    transform: translate(0, 0) scaleY(1);
  }
  62%, 78% {
    transform: translate(2.8px, -1px) scaleY(1);
  }
  86% {
    transform: translate(0, 0) scaleY(0.08);
  }
  88% {
    transform: translate(0, 0) scaleY(1);
  }
}

@keyframes rakazo-eyes-working {
  0% {
    transform: translate(-4px, 0) scale(0.92, 0.95);
  }
  25% {
    transform: translate(0, -2px) scale(1.08, 1.08);
  }
  50% {
    transform: translate(4px, 0) scale(0.92, 0.95);
  }
  75% {
    transform: translate(0, 2px) scale(1, 0.9);
  }
  100% {
    transform: translate(-4px, 0) scale(0.92, 0.95);
  }
}
`;

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
