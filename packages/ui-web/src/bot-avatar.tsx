import type { BotAvatarSet } from "@rakazo/contracts";
import type { AvatarEyes, BotColorDef, LogoAvatarActivity } from "@rakazo/core";
import {
  avatarCheer,
  avatarEyeRects,
  avatarIdentitySeed,
  BOT_AVATAR_COLORS,
  BOT_COLOR_LIST,
  botEyeTone,
  botFollowsTheme,
  DEFAULT_BOT_AVATAR_COLOR,
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_VIEWBOX,
  organicAvatarEyes,
  organicAvatarPath,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_EYES,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
  WORKING_RUN_STATUSES,
} from "@rakazo/core";
import { botCheekColor, botEyeColor } from "@rakazo/ui-tokens";
import type { ComponentProps, CSSProperties } from "react";
import { memo, useEffect, useMemo } from "react";
import { watchAvatarLook } from "./avatar-look.js";
import { useBotAvatarActivity } from "./bot-avatar-activity.js";
import { useAvatarHop } from "./hooks/use-avatar-hop.js";
import { useAvatarMotionVisibility } from "./hooks/use-avatar-motion-visibility.js";
import { useMotionSlot } from "./hooks/use-motion-slot.js";
import { cn } from "./lib/utils.js";
import { LogoAvatar } from "./logo-avatar.js";
import "./styles.css";

export type { BotColorDef };
export { BOT_AVATAR_COLORS, BOT_COLOR_LIST, DEFAULT_BOT_AVATAR_COLOR, resolvePersonaColorDef };

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
  /** Never play the working motion here (the chat title, the bot's own profile). */
  still?: boolean;
  /** Claim a working-motion slot ahead of the roster (the status row). */
  motionPriority?: boolean;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  avatarSet,
  activity,
  size = 36,
  status,
  identity = "",
  className,
  still = false,
  motionPriority = false,
}: BotAvatarProps) {
  // Generating only: a bot waiting on the person holds still.
  const isWorking = !still && WORKING_RUN_STATUSES.some((s) => s === status);

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <ImageAvatar
        url={parsed.imageUrl}
        size={size}
        working={isWorking}
        priority={motionPriority}
        className={className}
      />
    );
  }

  if (parsed.shapeIndex === undefined && avatarSet === "rakazo") {
    // Rakazo faces keep their upstream motion everywhere (task props, gaze); only the
    // pointer look-at and the plate-free body are new.
    const Avatar = activity === undefined ? LiveLogoAvatar : LogoAvatar;
    return (
      <Avatar
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
    const seed = avatarIdentitySeed(effectiveId || DEFAULT_BOT_AVATAR_COLOR);
    return (
      <FaceAvatar
        className={cn("rakazo-organic-avatar", className)}
        family={seed % ORGANIC_AVATAR_FAMILY_COUNT}
        viewBox={ORGANIC_AVATAR_VIEWBOX}
        body={organicAvatarPath(seed)}
        eyes={organicAvatarEyes(seed)}
        color={colorDef.hex}
        size={size}
        working={isWorking}
        priority={motionPriority}
      />
    );
  }

  return (
    <FaceAvatar
      className={cn("bot-avatar-container", className)}
      viewBox={VIEWBOX}
      body={shippedBotAvatarShapePath(parsed.shapeIndex)}
      eyes={SHIPPED_BOT_AVATAR_EYES}
      color={colorDef.hex}
      size={size}
      working={isWorking}
      priority={motionPriority}
    />
  );
});

/**
 * The bot whose computer is asleep or waking: its own body in grey with a face that sleeps
 * (bar eyes, drifting z's, slow breathing) or wakes (eyes open, look around, blink, stretch).
 * Sets without a drawn body (Rakazo logos, photos) sleep as their usual avatar, greyed.
 */
export function BotSleepFace({
  color,
  identity = "",
  avatarSet,
  state,
  size = 64,
}: {
  color: string;
  identity?: string;
  avatarSet?: BotAvatarSet;
  state: "asleep" | "waking";
  size?: number;
}) {
  const parsed = parseBotAvatar(color, identity);
  const seed = avatarIdentitySeed(identity || parsed.color || DEFAULT_BOT_AVATAR_COLOR);
  const drawn = !parsed.isImage && (parsed.shapeIndex !== undefined || avatarSet !== "rakazo");
  const shape =
    parsed.shapeIndex === undefined
      ? {
          viewBox: ORGANIC_AVATAR_VIEWBOX,
          body: organicAvatarPath(seed),
          eyes: organicAvatarEyes(seed),
        }
      : {
          viewBox: VIEWBOX,
          body: shippedBotAvatarShapePath(parsed.shapeIndex),
          eyes: SHIPPED_BOT_AVATAR_EYES,
        };
  return (
    <div
      className="rakazo-sleep-face relative"
      data-state={state}
      style={{ width: size, height: size }}
    >
      {drawn ? (
        <svg
          viewBox={shape.viewBox}
          aria-hidden="true"
          className="size-full overflow-visible"
          style={{ "--u": viewBoxUnits(shape.viewBox) / 100 } as CSSProperties}
        >
          <path d={shape.body} className="fill-muted-foreground" />
          <g className="avatar-gaze" fill={botEyeColor}>
            {avatarEyeRects(shape.eyes).map((rect) => (
              <rect key={rect.x} className="avatar-eye" {...rect} />
            ))}
          </g>
        </svg>
      ) : (
        <BotAvatar
          color={color}
          identity={identity}
          avatarSet={avatarSet}
          size={size}
          className="opacity-60 grayscale"
        />
      )}
      <span aria-hidden="true" className="sleep-z">
        <b>z</b>
        <b>z</b>
        <b>z</b>
      </span>
    </div>
  );
}

/** Only live Rakazo consumers subscribe to public activity updates. */
function LiveLogoAvatar({
  status,
  ...props
}: ComponentProps<typeof LogoAvatar> & { status?: string }) {
  const activity = useBotAvatarActivity(props.identity ?? "", status);
  return <LogoAvatar {...props} activity={activity} />;
}

/** An uploaded picture has no face to animate: while its bot works it just bounces. */
function ImageAvatar({
  url,
  size,
  working,
  priority,
  className,
}: {
  url: string;
  size: number;
  working: boolean;
  priority: boolean;
  className?: string;
}) {
  const moving = useMotionSlot(working, priority);
  return (
    <div
      className={cn("rakazo-bot-avatar relative shrink-0 select-none", className)}
      data-working={working}
      data-paused={working && !moving}
      style={{ width: size, height: size }}
    >
      <div className="rakazo-bot-avatar-picture flex h-full w-full overflow-hidden rounded-full bg-secondary">
        <img src={url} alt="" className="h-full w-full object-cover" />
      </div>
    </div>
  );
}

/**
 * A flat bot body with two upright eyes. It hops once when its colour or shape changes, plays
 * the working loop while its bot works, and turns toward the pointer when hovered.
 */
function FaceAvatar({
  family,
  viewBox,
  body,
  eyes,
  color,
  size,
  working,
  priority = false,
  className,
}: {
  /** The organic body family, for previews that report which body they show. */
  family?: number;
  viewBox: string;
  body: string;
  eyes: AvatarEyes;
  color: string;
  size: number;
  working: boolean;
  priority?: boolean;
  className?: string;
}) {
  const { ref, visible } = useAvatarMotionVisibility(true);
  const { hopping, onAnimationEnd } = useAvatarHop(`${body}${color}`);
  const moving = useMotionSlot(working && visible, priority);
  useEffect(() => watchAvatarLook(), []);
  const unit = viewBoxUnits(viewBox) / 100;
  const followsTheme = botFollowsTheme(color);
  const ink = followsTheme
    ? { fill: "fill-background", stroke: "stroke-background" }
    : eyeInk(color);
  const cheer = avatarCheer(eyes);
  return (
    <svg
      ref={ref}
      viewBox={viewBox}
      aria-hidden="true"
      className={cn("rakazo-avatar-face select-none", className)}
      data-look={unit}
      data-shape-family={family}
      data-working={working && !hopping}
      data-hop={hopping}
      data-paused={!visible || (working && !moving)}
      onAnimationEnd={onAnimationEnd}
      style={{ width: size, height: size, "--u": unit } as CSSProperties}
    >
      <path
        className={cn("avatar-body", followsTheme && "fill-foreground")}
        d={body}
        fill={followsTheme ? undefined : color}
      />
      <g className="avatar-look">
        <g className={cn("avatar-gaze", ink.fill)} fill={ink.color}>
          {avatarEyeRects(eyes).map((rect) => (
            <rect key={rect.x} className="avatar-eye" {...rect} />
          ))}
        </g>
      </g>
      <g className="avatar-cheer">
        {cheer.cheeks.map((cheek) => (
          <ellipse key={cheek.cx} {...cheek} fill={botCheekColor} fillOpacity={0.55} />
        ))}
        <path
          d={cheer.smile}
          fill="none"
          className={ink.stroke}
          stroke={ink.color}
          strokeWidth={3.8 * unit}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

function viewBoxUnits(viewBox: string): number {
  return Number(viewBox.split(" ")[2]) || 100;
}

function BarEyes({ eyes }: { eyes: AvatarEyes }) {
  return avatarEyeRects(eyes).map((rect) => <rect key={rect.x} {...rect} />);
}

/**
 * Eye ink (see `botEyeInk`): the dark bot-eye ink on a coloured body; on a near-white or
 * near-black body the page ink that contrasts with it, following the theme.
 */
function eyeInk(bodyHex: string): { fill?: string; stroke?: string; color?: string } {
  const tone = botEyeTone(bodyHex);
  if (tone === "dark")
    return {
      fill: "fill-foreground dark:fill-background",
      stroke: "stroke-foreground dark:stroke-background",
    };
  if (tone === "light")
    return {
      fill: "fill-background dark:fill-foreground",
      stroke: "stroke-background dark:stroke-foreground",
    };
  return { color: botEyeColor };
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
        "relative flex size-11 items-center justify-center rounded-[10px] bg-secondary transition-[background-color,scale] duration-150 hover:bg-accent active:scale-92 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover motion-reduce:active:scale-100",
        selected && "ring-[1.5px] ring-muted-foreground",
      )}
    >
      {shapeIndex === undefined ? (
        <BotAvatar color={color} identity={identity} size={32} />
      ) : (
        <svg viewBox={VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
          <path d={shippedBotAvatarShapePath(shapeIndex)} fill={colorDef.hex} />
          <g className={eyeInk(colorDef.hex).fill} fill={eyeInk(colorDef.hex).color}>
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
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
