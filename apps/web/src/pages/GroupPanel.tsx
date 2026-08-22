import type { Bot, Group } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { useMemo, useState } from "react";

export function CreateGroupForm({
  bots,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (input: { name: string; botIds: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    setSelected((current) => {
      if (current.includes(botId)) return current.filter((id) => id !== botId);
      if (current.length >= 6) return current;
      return [...current, botId];
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">New group</span>
        <button type="button" onClick={onCancel}>
          ✕
        </button>
      </div>
      <label className="block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this group"
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <div className="mt-5 text-[14px] text-[#85858A]">Members (pick 2–6)</div>
      <div className="mt-2 max-h-[280px] space-y-1 overflow-y-auto">
        {selectable.map((bot) => {
          const checked = selected.includes(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => toggle(bot.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left ${
                checked ? "bg-[#1A1A1D]" : "hover:bg-[#141416]"
              }`}
            >
              <BotAvatar color={bot.color} size={32} />
              <span className="flex-1 text-[15px] text-[#ECECEE]">{bot.name}</span>
              <span className="text-[13px] text-[#6C6C70]">{checked ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[12.5px] text-[#6C6C70]">
        @everyone is available in the composer — use sparingly.
      </p>
      <Button
        className="mt-5 w-full"
        disabled={!name.trim() || selected.length < 2 || selected.length > 6}
        onClick={() => onCreate({ name: name.trim(), botIds: selected })}
      >
        Create group
      </Button>
    </div>
  );
}

export function GroupSettings({
  group,
  bots,
  onSave,
  onRemove,
}: {
  group: Group;
  bots: Bot[];
  onSave: (input: { name?: string; botIds?: string[] }) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    setSelected((current) => {
      if (current.includes(botId)) return current.filter((id) => id !== botId);
      if (current.length >= 6) return current;
      return [...current, botId];
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">Group settings</span>
      </div>
      <label className="block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <div className="mt-5 text-[14px] text-[#85858A]">Members (2–6)</div>
      <div className="mt-2 max-h-[240px] space-y-1 overflow-y-auto">
        {selectable.map((bot) => {
          const checked = selected.includes(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => toggle(bot.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left ${
                checked ? "bg-[#1A1A1D]" : "hover:bg-[#141416]"
              }`}
            >
              <BotAvatar color={bot.color} size={32} />
              <span className="flex-1 text-[15px] text-[#ECECEE]">{bot.name}</span>
              <span className="text-[13px] text-[#6C6C70]">{checked ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>
      <Button
        className="mt-5 w-full"
        disabled={!name.trim() || selected.length < 2 || selected.length > 6}
        onClick={() =>
          onSave({
            name: name.trim() !== group.name ? name.trim() : undefined,
            botIds:
              selected.join(",") !== group.members.map((m) => m.botId).join(",")
                ? selected
                : undefined,
          })
        }
      >
        Save
      </Button>
      <button
        type="button"
        onClick={onRemove}
        className="mt-4 w-full rounded-[11px] border border-[#3A2020] px-3.5 py-3 text-[14px] text-[#FF6B6B]"
      >
        Delete group
      </button>
    </div>
  );
}

export function memberName(
  members: Group["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}
