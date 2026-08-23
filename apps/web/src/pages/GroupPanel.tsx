import { type Bot, GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, type Group } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { useMemo, useState } from "react";

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function MemberPicker({
  bots,
  selected,
  onChange,
  maxHeight,
}: {
  bots: Bot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxHeight: "max-h-[240px]" | "max-h-[280px]";
}) {
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    if (selected.includes(botId)) {
      onChange(selected.filter((id) => id !== botId));
    } else if (selected.length < GROUP_MEMBER_MAX) {
      onChange([...selected, botId]);
    }
  }

  return (
    <div className={`mt-2 ${maxHeight} space-y-1 overflow-y-auto`}>
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
  );
}

export function CreateGroupForm({
  bots,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (input: { name: string; botIds: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (submitting || !validSelection(name, selected)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), botIds: selected });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create group");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">New group</span>
        <button type="button" aria-label="Cancel new group" onClick={onCancel}>
          ✕
        </button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-[#C94244]">
          {error}
        </p>
      ) : null}
      <label className="block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this group"
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <div className="mt-5 text-[14px] text-[#85858A]">
        Members (pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[280px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={submitting || !validSelection(name, selected)}
        onClick={() => void create()}
      >
        {submitting ? "Creating…" : "Create group"}
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
  onSave: (input: { name?: string; botIds?: string[] }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(kind: "save" | "remove", action: () => Promise<void>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${kind} group`);
    } finally {
      setPending(null);
    }
  }

  function save() {
    return onSave({
      name: name.trim() !== group.name ? name.trim() : undefined,
      botIds: sameMembers(
        selected,
        group.members.map((member) => member.botId),
      )
        ? undefined
        : selected,
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">Group settings</span>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-[#C94244]">
          {error}
        </p>
      ) : null}
      <label className="block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <div className="mt-5 text-[14px] text-[#85858A]">
        Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[240px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={pending !== null || !validSelection(name, selected)}
        onClick={() => void mutate("save", save)}
      >
        {pending === "save" ? "Saving…" : "Save"}
      </Button>
      <button
        type="button"
        disabled={pending !== null}
        onClick={() => void mutate("remove", onRemove)}
        className="mt-4 w-full rounded-[11px] border border-[#3A2020] px-3.5 py-3 text-[14px] text-[#FF6B6B] disabled:opacity-40"
      >
        {pending === "remove" ? "Deleting…" : "Delete group"}
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
