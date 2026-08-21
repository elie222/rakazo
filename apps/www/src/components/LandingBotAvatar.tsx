const AVATAR_BY_COLOR: Record<string, string> = {
  "#3ec5a8": "/avatars/bot-avatar-teal.svg",
  "#f5a03c": "/avatars/bot-avatar-orange.svg",
  "#6a6bf5": "/avatars/bot-avatar-indigo.svg",
  "#9b5cf6": "/avatars/bot-avatar-violet.svg",
  "#3b82f6": "/avatars/bot-avatar-blue.svg",
  "#f2622a": "/avatars/bot-avatar-coral.svg",
  "#d9508a": "/avatars/bot-avatar-pink.svg",
};

export function LandingBotAvatar({
  color,
  size = 38,
  className,
}: {
  color: string;
  size?: number;
  className?: string;
}) {
  const src = AVATAR_BY_COLOR[color.toLowerCase()] ?? "/avatars/bot-avatar-coordinator.svg";

  return (
    <img
      aria-hidden="true"
      alt=""
      className={className}
      draggable={false}
      height={size}
      src={src}
      style={{ width: size, height: size, flex: "none" }}
      width={size}
    />
  );
}
