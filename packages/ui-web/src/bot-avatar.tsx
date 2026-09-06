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
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const seed = avatarIdentitySeed(identity || color || "#8B5CF6");
  const duration = `${4.8 + (seed % 24) / 10}s`;
  const shapeA = organicAvatarPath(seed);
  const shapeB = organicAvatarPath(seed, 0.42);

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
          fill={color}
          style={
            {
              "--rakazo-organic-path": `path("${shapeA}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color})`
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
