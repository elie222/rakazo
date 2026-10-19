import { BotAvatar } from "@rakazo/ui-web";

export function LandingBotAvatar({
  color,
  size = 38,
  className,
}: {
  color: string;
  size?: number;
  className?: string;
}) {
  return <BotAvatar color={color} size={size} className={className} variant="organic" />;
}
