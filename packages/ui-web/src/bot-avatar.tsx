import type { BotAvatarSet, BotColorDef } from "@rakazo/contracts";
import { BOT_COLOR_LIST, BOT_COLORS } from "@rakazo/contracts";
import type { AvatarEyes, LogoAvatarActivity } from "@rakazo/core";
import {
  avatarEyeRects,
  avatarIdentitySeed,
  avatarPhaseMs,
  avatarSharedTimeMs,
  botEyeTone,
  DEFAULT_BOT_AVATAR_COLOR,
  isRunWorking,
  ORGANIC_AVATAR_EYES,
  ORGANIC_AVATAR_VIEWBOX,
  organicAvatarEyeTilt,
  organicAvatarPath,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_EYES,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
} from "@rakazo/core";
import type { ComponentProps, CSSProperties } from "react";
import { memo, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useBotAvatarActivity } from "./bot-avatar-activity.js";
import { useAvatarMotionVisibility } from "./hooks/use-avatar-motion-visibility.js";
import { syncAvatarAnimations } from "./lib/sync-avatar-animations.js";
import { cn } from "./lib/utils.js";
import { LogoAvatar } from "./logo-avatar.js";
import "./styles.css";

export type { BotColorDef };
export { BOT_COLOR_LIST, BOT_COLORS, DEFAULT_BOT_AVATAR_COLOR, resolvePersonaColorDef };

export const BOT_SHAPES = SHIPPED_BOT_AVATAR_SHAPES;
export const SHIPPED_SHAPE_KEYS = SHIPPED_BOT_AVATAR_SHAPE_KEYS;
const VIEWBOX = SHIPPED_BOT_AVATAR_VIEWBOX;

export const BOT_MASCOT_SHAPES = SHIPPED_SHAPE_KEYS.map(
  (k) => BOT_SHAPES[k] ?? FALLBACK_SHAPE_PATH,
);

const FALLBACK_SHAPE_PATH = BOT_SHAPES.hex ?? "";

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  // Only data: image URLs are rendered. Arbitrary http(s)/blob values in `color`
  // must not become <img src> (SSRF / tracking when other members view the bot).
  if (rawColor.startsWith("data:image/")) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const rawShapeIdx = parts[1] ?? "0";
    const parsedShapeIdx = /^\d+$/.test(rawShapeIdx) ? Number(rawShapeIdx) : 0;
    const shapeIdx = Number.isSafeInteger(parsedShapeIdx) ? parsedShapeIdx : 0;
    return {
      color: parts[0] || "#F97316",
      shapeIndex: shapeIdx % SHIPPED_SHAPE_KEYS.length,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

const AVATAR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function defaultBotAvatarValue(rawColor: string): string {
  const parsed = parseBotAvatar(rawColor);
  if (rawColor && !parsed.isImage && AVATAR_HEX.test(parsed.color)) return parsed.color;
  return DEFAULT_BOT_AVATAR_COLOR;
}

export interface BotAvatarProps {
  color: string;
  avatarSet?: BotAvatarSet;
  activity?: LogoAvatarActivity;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  avatarSet,
  activity,
  size = 36,
  status,
  identity = "",
  className,
}: BotAvatarProps) {
  const isWorking = isRunWorking(status);

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn("rakazo-bot-avatar relative shrink-0 select-none", className)}
        data-working={isWorking}
        style={{ width: size, height: size }}
      >
        <div className="rakazo-bot-avatar-picture relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-border bg-secondary">
          <img src={parsed.imageUrl} alt="" className="h-full w-full object-cover" />
        </div>
        {isWorking ? (
          <svg
            className="rakazo-bot-avatar-ring rakazo-bot-avatar-ring-working absolute pointer-events-none"
            style={{
              inset: -4,
              width: size + 8,
              height: size + 8,
            }}
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="24"
              cy="24"
              r="22"
              className="stroke-status-working"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeDasharray="45 80"
            />
          </svg>
        ) : null}
      </div>
    );
  }

  if (parsed.shapeIndex === undefined && avatarSet === "rakazo") {
    const Avatar = activity === undefined ? LiveLogoAvatar : LogoAvatar;
    return (
      <Avatar
        // Another bot brings new CSS loops; a fresh avatar joins them to the shared clock.
        key={effectiveId}
        avatarValue={color ? colorDef.hex : undefined}
        identity={effectiveId}
        size={size}
        activity={activity}
        status={status}
        className={className}
      />
    );
  }
  if (parsed.shapeIndex === undefined) {
    return (
      <OrganicAvatar
        color={colorDef.hex}
        identity={effectiveId}
        size={size}
        isWorking={isWorking}
        className={className}
      />
    );
  }

  return (
    <MascotAvatar
      color={colorDef.hex}
      seed={avatarIdentitySeed(effectiveId)}
      body={shippedBotAvatarShapePath(parsed.shapeIndex)}
      viewBox={VIEWBOX}
      eyes={SHIPPED_BOT_AVATAR_EYES}
      size={size}
      isWorking={isWorking}
      className={cn("rakazo-shape-avatar", className)}
    />
  );
});

/** Only live Rakazo consumers subscribe to public activity updates. */
function LiveLogoAvatar({
  status,
  ...props
}: ComponentProps<typeof LogoAvatar> & { status?: string }) {
  const activity = useBotAvatarActivity(props.identity ?? "", status);
  return <LogoAvatar {...props} activity={activity} />;
}

function OrganicAvatar({
  color,
  identity,
  className,
  ...props
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const seed = avatarIdentitySeed(identity || color || DEFAULT_BOT_AVATAR_COLOR);
  return (
    <MascotAvatar
      {...props}
      color={color}
      seed={seed}
      body={organicAvatarPath(seed)}
      morph={organicAvatarPath(seed, 0.42)}
      viewBox={ORGANIC_AVATAR_VIEWBOX}
      eyes={ORGANIC_AVATAR_EYES}
      eyeTilt={organicAvatarEyeTilt(seed)}
      className={cn("rakazo-organic-avatar", className)}
    />
  );
}

/** A body with bar eyes that moves while its bot works; the seed picks the motion. */
function MascotAvatar({
  color,
  seed,
  body,
  morph,
  viewBox,
  eyes,
  eyeTilt = 0,
  size,
  isWorking,
  className,
}: {
  color: string;
  seed: number;
  body: string;
  morph?: string;
  viewBox: string;
  eyes: AvatarEyes;
  eyeTilt?: number;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const { ref, visible } = useAvatarMotionVisibility(!reducedMotion);
  const morphMs = 4800 + (seed % 24) * 100;
  // The CSS loops take their timing from the shape family alone; this offset keeps two
  // different bots of one family from moving in unison while copies of one bot still match.
  const phaseMs = avatarPhaseMs(seed);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // Every copy of a bot's avatar moves together, however long each has been on screen.
    syncAvatarAnimations(svg, phaseMs);
    // jsdom has no SMIL clock, so these are optional.
    if (!visible) {
      svg.pauseAnimations?.();
      return;
    }
    svg.unpauseAnimations?.();
    svg.setCurrentTime?.(((avatarSharedTimeMs() + phaseMs) % morphMs) / 1000);
  }, [ref, visible, isWorking, reducedMotion, morphMs, phaseMs]);
  const eyeOrigin = `${(eyes.leftCx + eyes.rightCx) / 2}px ${eyes.cy}px`;
  const unit = viewBoxWidth(viewBox) / viewBoxWidth(ORGANIC_AVATAR_VIEWBOX);

  return (
    <svg
      ref={ref}
      viewBox={viewBox}
      aria-hidden="true"
      className={cn("rakazo-mascot-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-paused={!visible}
      data-shape-family={seed % 10}
      data-eye-pattern={seed % 4}
      // Inline size so a parent's icon sizing (Button sizes bare SVGs) cannot shrink it.
      style={
        {
          width: size,
          height: size,
          flex: "none",
          "--rakazo-mascot-unit": `${unit}px`,
        } as CSSProperties
      }
    >
      {(["idle", "working"] as const).map((mode) => (
        <path
          key={mode}
          className={`rakazo-mascot-avatar-body rakazo-mascot-avatar-body-${mode}`}
          d={body}
          fill={color}
          style={
            {
              "--rakazo-mascot-path": `path("${body}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16 * unit)}px ${color})`
                  : "drop-shadow(0 calc(2 * var(--rakazo-mascot-unit)) calc(3 * var(--rakazo-mascot-unit)) rgba(0,0,0,.34))",
            } as CSSProperties
          }
        >
          {/* Only a working body morphs, on the svg clock the effect above sets. */}
          {morph && !reducedMotion && mode === "working" && isWorking ? (
            <animate
              attributeName="d"
              values={`${body};${morph};${body}`}
              dur={`${morphMs}ms`}
              repeatCount="indefinite"
            />
          ) : null}
        </path>
      ))}
      <g transform={`rotate(${eyeTilt})`}>
        {(["idle", "working"] as const).map((mode) => (
          <g
            key={mode}
            className={`rakazo-mascot-avatar-eyes rakazo-mascot-avatar-eyes-${mode} ${eyeFill(color)}`}
            style={{ transformOrigin: eyeOrigin }}
          >
            <BarEyes eyes={eyes} />
          </g>
        ))}
      </g>
    </svg>
  );
}

function viewBoxWidth(viewBox: string): number {
  return Number(viewBox.split(" ")[2]);
}

function BarEyes({ eyes }: { eyes: AvatarEyes }) {
  return avatarEyeRects(eyes).map((rect) => <rect key={rect.x} {...rect} />);
}

/** Eyes are cut-outs in the page color unless the body is nearly white or black. */
function eyeFill(bodyHex: string): string {
  const tone = botEyeTone(bodyHex);
  if (tone === "dark") return "fill-foreground dark:fill-background";
  if (tone === "light") return "fill-background dark:fill-foreground";
  return "fill-background";
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

export function BotShapePreview({
  shapeIndex,
  identity,
  label,
  color,
  selected,
  onClick,
}: {
  /** An Avatar Studio shape; omit it to draw the organic body `identity` gets. */
  shapeIndex?: number;
  identity?: string;
  label?: string;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const key =
    shapeIndex === undefined
      ? undefined
      : (SHIPPED_SHAPE_KEYS[shapeIndex % SHIPPED_SHAPE_KEYS.length] ?? "hex");
  const colorDef = resolvePersonaColorDef("preview", color);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? key}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      {shapeIndex === undefined ? (
        <BotAvatar color={color} identity={identity} size={32} />
      ) : (
        <svg viewBox={VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
          <path d={shippedBotAvatarShapePath(shapeIndex)} fill={colorDef.hex} />
          <g className={eyeFill(colorDef.hex)}>
            <BarEyes eyes={SHIPPED_BOT_AVATAR_EYES} />
          </g>
        </svg>
      )}
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      {/* off-scale: wordmark sized to the 44px logo mark */}
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
