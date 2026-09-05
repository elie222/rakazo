import { Trans, useLingui } from "@lingui/react/macro";
import { type Bot, GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, type Group } from "@rakazo/contracts";
import { BotAvatar, Button, Input } from "@rakazo/ui-web";
import { Check, X } from "lucide-react";
import { useId, useMemo, useState } from "react";

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
            aria-pressed={checked}
            onClick={() => toggle(bot.id)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start ${
              checked ? "bg-muted" : "hover:bg-accent"
            }`}
          >
            <BotAvatar color={bot.color} identity={bot.id} size={32} status={bot.status} />
            <span className="flex-1 text-[15px] text-foreground" dir="auto">
              {bot.name}
            </span>
            {checked ? <Check size={14} className="text-muted-foreground" aria-hidden /> : null}
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
  const { t } = useLingui();
  const nameId = useId();
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
      setError(cause instanceof Error ? cause.message : t`Could not create group`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this group`}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members (pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
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
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
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
  const { t } = useLingui();
  const nameId = useId();
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
      setError(
        cause instanceof Error
          ? cause.message
          : kind === "save"
            ? t`Could not save group`
            : t`Could not remove group`,
      );
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
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
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
        {pending === "save" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={pending !== null}
        onClick={() => void mutate("remove", onRemove)}
      >
        {pending === "remove" ? <Trans>Deleting…</Trans> : <Trans>Delete group</Trans>}
      </Button>
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
