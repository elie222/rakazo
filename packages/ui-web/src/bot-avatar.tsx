import { ACTIVE_RUN_STATUSES, avatarIdentitySeed, organicAvatarPath } from "@rakazo/core";
import { type CSSProperties, memo, useId, useSyncExternalStore } from "react";
import { type AvatarStyle, useAvatarStyle } from "./avatar-style.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  variant?: AvatarStyle;
  identity?: string;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 38,
  status,
  variant,
  identity,
  className,
}: BotAvatarProps) {
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const gradId = `spin-grad-${useId().replace(/[^a-zA-Z0-9-_]/g, "")}`;
  const preferredVariant = useAvatarStyle();
  if ((variant ?? preferredVariant) === "organic") {
    return (
      <OrganicAvatar
        color={color}
        identity={identity}
        size={size}
        isWorking={isWorking}
        className={className}
      />
    );
  }
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(4, Math.round(size * 0.14));
  const eyeH = Math.max(7, Math.round(size * 0.22));
  const eyeRadius = Math.max(2, Math.round(eyeW * 0.5));
  const eyeGap = Math.max(3, Math.round(size * 0.1));

  const seed = hashString(color || "#8B5CF6");
  const eyeVariant = seed % 4;
  const idleDuration = (4.2 + ((seed * 7) % 28) / 10).toFixed(2);
  const idleDelay = (-(((seed * 13) % 45) / 10)).toFixed(2);
  const eyeGlow = `0 0 4px #FFFFFF, 0 0 8px #FFFFFF, 0 0 14px ${lightenColor(color, 20)}`;
  const idleEyeAnimation = {
    "--rakazo-eye-animation-name": `rakazo-eyes-idle-${eyeVariant}`,
    "--rakazo-eye-animation-duration": `${idleDuration}s`,
    "--rakazo-eye-animation-easing": "cubic-bezier(0.4, 0, 0.2, 1)",
    "--rakazo-eye-animation-delay": `${idleDelay}s`,
  } as CSSProperties;
  const workingEyeAnimation = {
    "--rakazo-eye-animation-name": "rakazo-eyes-working",
    "--rakazo-eye-animation-duration": "1.4s",
    "--rakazo-eye-animation-easing": "ease-in-out",
    "--rakazo-eye-animation-delay": "0s",
  } as CSSProperties;

  return (
    <div
      className={cn(
        "rakazo-bot-avatar group relative flex items-center justify-center rounded-full select-none",
        className,
      )}
      data-working={isWorking}
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
      <svg
        className="rakazo-bot-avatar-ring absolute pointer-events-none"
        style={{
          inset: -4,
          width: size + 8,
          height: size + 8,
          filter: `drop-shadow(0 0 6px ${color}) drop-shadow(0 0 10px #ffffff)`,
        }}
        viewBox="0 0 48 48"
        fill="none"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke={`url(#${gradId})`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
        <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="60%" stopColor={color} stopOpacity="0.9" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>

      <div
        className="rakazo-bot-avatar-visor relative flex items-center justify-center overflow-hidden transition-transform duration-200 group-hover:scale-[1.04]"
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.52),
          background: "linear-gradient(180deg, #101014 0%, #030305 100%)",
          boxShadow: "inset 0 1.5px 3px rgba(0,0,0,0.95), 0 1px 1px rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div
          className="absolute top-0 inset-x-0 h-[40%] pointer-events-none rounded-t-full"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.01) 100%)",
          }}
        />

        {(["idle", "working"] as const).map((mode) => (
          <div
            key={mode}
            className={`rakazo-bot-avatar-eyes rakazo-bot-avatar-eyes-${mode} absolute inset-0 z-10 flex items-center justify-center`}
            style={{
              gap: eyeGap,
              ...(mode === "idle" ? idleEyeAnimation : workingEyeAnimation),
            }}
          >
            {[0, 1].map((eye) => (
              <span
                key={eye}
                className="block bg-white"
                style={{
                  width: eyeW,
                  height: eyeH,
                  borderRadius: eyeRadius,
                  backgroundColor: "#FFFFFF",
                  boxShadow: eyeGlow,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

export const GROK_BOT_COLORS = [
  "#FFFFFF", // White
  "#8D6E63", // Brown / Tan
  "#EF4444", // Red
  "#F97316", // Orange
  "#EAB308", // Yellow / Gold
  "#10B981", // Green
  "#06B6D4", // Teal / Cyan
  "#3B82F6", // Blue
  "#8B5CF6", // Purple
  "#EC4899", // Pink / Magenta
] as const;

export const GROK_MASCOT_SHAPES = [
  // 0: Horizontal egg / oval
  "M -46,0 C -46,-26 -26,-40 0,-40 C 26,-40 46,-26 46,0 C 46,26 26,40 0,40 C -26,40 -46,26 -46,0 Z",
  // 1: Round circle / egg
  "M 0,-44 C 24.3,-44 44,-24.3 44,0 C 44,24.3 24.3,44 0,44 C -24.3,44 -44,24.3 -44,0 C -44,-24.3 -24.3,-44 0,-44 Z",
  // 2: Squircle / rounded box
  "M -36,-36 C -12,-41 12,-41 36,-36 C 41,-12 41,12 36,36 C 12,41 -12,41 -36,36 C -41,12 -41,-12 -36,-36 Z",
  // 3: Oblong capsule
  "M -48,-18 C -48,-30 -36,-32 0,-32 C 36,-32 48,-30 48,-18 C 48,18 36,30 0,30 C -36,30 -48,18 -48,-18 Z",
  // 4: Rounded triangle
  "M 0,-44 C 8,-44 16,-30 38,20 C 44,32 36,40 20,40 C -4,40 -20,40 -36,40 C -44,40 -46,30 -38,20 C -16,-30 -8,-44 0,-44 Z",
  // 5: Hexagon
  "M -22,-40 L 22,-40 C 30,-40 38,-32 42,-20 L 46,0 L 42,20 C 38,32 30,40 22,40 L -22,40 C -30,40 -38,32 -42,20 L -46,0 L -42,-20 C -38,-32 -30,-40 -22,-40 Z",
  // 6: Cloud
  "M -38,18 C -46,14 -46,-6 -34,-12 C -34,-32 -10,-40 6,-32 C 16,-42 38,-32 38,-16 C 48,-8 48,12 38,20 C 34,36 12,38 0,34 C -14,38 -32,34 -38,18 Z",
  // 7: Teardrop
  "M 0,-46 C 14,-22 42,-2 42,16 C 42,34 23.2,42 0,42 C -23.2,42 -42,34 -42,16 C -42,-2 -14,-22 0,-46 Z",
] as const;

export function parseBotAvatar(rawColor: string, identity?: string): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  if (
    rawColor.startsWith("data:image/") ||
    rawColor.startsWith("http://") ||
    rawColor.startsWith("https://") ||
    rawColor.startsWith("blob:")
  ) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const shapeIdx = parseInt(parts[1] ?? "0", 10);
    return {
      color: parts[0] || "#F97316",
      shapeIndex: isNaN(shapeIdx) ? undefined : shapeIdx % 8,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

export function GrokShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const path = GROK_MASCOT_SHAPES[shapeIndex % 8];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none",
        selected ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10" : "hover:bg-white/5",
      )}
    >
      <svg viewBox="-60 -60 120 120" className="size-8 overflow-visible">
        <path d={path} fill={color} />
        <g transform="rotate(-6)">
          <rect x="-14" y="-12" width="7" height="24" rx="3.5" fill="#101014" />
          <rect x="7" y="-12" width="7" height="24" rx="3.5" fill="#101014" />
        </g>
      </svg>
    </button>
  );
}

function OrganicAvatar({
  color,
  identity,
  size,
  isWorking,
  className,
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const parsed = parseBotAvatar(color, identity);
  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn(
          "rakazo-bot-avatar-image relative overflow-hidden rounded-full flex items-center justify-center select-none bg-[#1A1C22]",
          className,
        )}
        style={{
          width: size,
          height: size,
          flex: "none",
          boxShadow: isWorking
            ? `0 0 0 2px #3B82F6, 0 0 ${Math.round(size * 0.3)}px #3B82F6`
            : "0 2px 4px rgba(0,0,0,0.4)",
        }}
      >
        <img src={parsed.imageUrl} alt="Bot Avatar" className="w-full h-full object-cover" />
      </div>
    );
  }

  const effectiveColor = parsed.color;
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const seed = avatarIdentitySeed(identity || effectiveColor || "#8B5CF6");
  const duration = `${4.8 + (seed % 24) / 10}s`;

  const shapeA =
    parsed.shapeIndex !== undefined
      ? GROK_MASCOT_SHAPES[parsed.shapeIndex]
      : organicAvatarPath(seed);
  const shapeB =
    parsed.shapeIndex !== undefined
      ? GROK_MASCOT_SHAPES[parsed.shapeIndex]
      : organicAvatarPath(seed, 0.42);

  return (
    <svg
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("rakazo-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape-family={seed % 10}
      data-eye-pattern={seed % 4}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      {(["idle", "working"] as const).map((mode) => (
        <path
          key={mode}
          className={`rakazo-organic-avatar-body rakazo-organic-avatar-body-${mode}`}
          d={shapeA}
          fill={effectiveColor}
          style={
            {
              "--rakazo-organic-path": `path("${shapeA}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${effectiveColor})`
                  : "drop-shadow(0 2px 3px rgba(0,0,0,.34))",
            } as CSSProperties
          }
        >
          {!reducedMotion ? (
            <animate
              attributeName="d"
              values={`${shapeA};${shapeB};${shapeA}`}
              dur={duration}
              repeatCount="indefinite"
            />
          ) : null}
        </path>
      ))}
      <g transform={`rotate(${(seed % 9) - 4})`}>
        {(["idle", "working"] as const).map((mode) => (
          <g
            key={mode}
            className={`rakazo-organic-avatar-eyes rakazo-organic-avatar-eyes-${mode}`}
            fill="#101014"
          >
            <rect x="-14" y="-12" width="7" height="24" rx="3.5" />
            <rect x="7" y="-12" width="7" height="24" rx="3.5" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const reducedMotionMedia = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(reducedMotionMedia).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(reducedMotionMedia);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
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
  const num = parseInt(
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean,
    16,
  );
  if (Number.isNaN(num)) return hex;
  let r = (num >> 16) + Math.round((255 * percent) / 100);
  let g = ((num >> 8) & 0x00ff) + Math.round((255 * percent) / 100);
  let b = (num & 0x0000ff) + Math.round((255 * percent) / 100);
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
