import { BotAvatar } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  status?: string;
}

export interface GroupAvatarProps {
  members: GroupAvatarMember[];
  size?: number;
  className?: string;
}

export function GroupAvatar({
  members,
  size = 38,
  className,
}: GroupAvatarProps) {
  if (!members || members.length === 0) {
    return (
      <div
        className={cn(
          "relative flex items-center justify-center rounded-full bg-[#1A1A1E] text-[#9A9AA2] border border-[#2A2A32]",
          className,
        )}
        style={{ width: size, height: size, flex: "none" }}
      >
        <svg
          width={Math.round(size * 0.48)}
          height={Math.round(size * 0.48)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={members[0]!.color}
        size={size}
        status={members[0]!.status}
        className={className}
      />
    );
  }

  // 2 Bots layout: Diagonal overlapping mini bot avatars
  if (members.length === 2) {
    const miniSize = Math.round(size * 0.65);
    return (
      <div
        className={cn("relative rounded-full select-none", className)}
        style={{ width: size, height: size, flex: "none" }}
      >
        {/* Top-Left Avatar */}
        <div
          className="absolute z-10 rounded-full"
          style={{
            top: 0,
            left: 0,
            boxShadow: "0 0 0 1.5px #121215",
          }}
        >
          <BotAvatar
            color={members[0]!.color}
            size={miniSize}
            status={members[0]!.status}
          />
        </div>

        {/* Bottom-Right Avatar */}
        <div
          className="absolute z-20 rounded-full"
          style={{
            bottom: 0,
            right: 0,
            boxShadow: "0 0 0 1.5px #121215",
          }}
        >
          <BotAvatar
            color={members[1]!.color}
            size={miniSize}
            status={members[1]!.status}
          />
        </div>
      </div>
    );
  }

  // 3+ Bots layout: 3-way mini avatar cluster
  const miniSize = Math.round(size * 0.54);
  const extraCount = members.length - 2;

  return (
    <div
      className={cn("relative rounded-full select-none", className)}
      style={{ width: size, height: size, flex: "none" }}
    >
      {/* Top Center Avatar */}
      <div
        className="absolute z-10 rounded-full -translate-x-1/2"
        style={{
          top: 0,
          left: "50%",
          boxShadow: "0 0 0 1.5px #121215",
        }}
      >
        <BotAvatar
          color={members[0]!.color}
          size={miniSize}
          status={members[0]!.status}
        />
      </div>

      {/* Bottom Left Avatar */}
      <div
        className="absolute z-20 rounded-full"
        style={{
          bottom: 0,
          left: 0,
          boxShadow: "0 0 0 1.5px #121215",
        }}
      >
        <BotAvatar
          color={members[1]!.color}
          size={miniSize}
          status={members[1]!.status}
        />
      </div>

      {/* Bottom Right Avatar or +N overflow badge */}
      {members.length === 3 ? (
        <div
          className="absolute z-30 rounded-full"
          style={{
            bottom: 0,
            right: 0,
            boxShadow: "0 0 0 1.5px #121215",
          }}
        >
          <BotAvatar
            color={members[2]!.color}
            size={miniSize}
            status={members[2]!.status}
          />
        </div>
      ) : (
        <div
          className="absolute z-30 flex items-center justify-center rounded-full bg-[#202026] text-[#E0E0E6] font-semibold text-[10px]"
          style={{
            bottom: 0,
            right: 0,
            width: miniSize,
            height: miniSize,
            boxShadow: "0 0 0 1.5px #121215",
          }}
        >
          {`+${extraCount}`}
        </div>
      )}
    </div>
  );
}
