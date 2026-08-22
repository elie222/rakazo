import type { Bot } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";

export function NewChannelDialog({
  bots,
  onCancel,
  onConfirm,
}: {
  bots: Bot[];
  onCancel: () => void;
  onConfirm: (input: { name: string; botIds: string[] }) => Promise<void>;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [botIds, setBotIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={() => {
        if (!saving) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-channel-title"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || saving) return;
          setSaving(true);
          setError(null);
          void onConfirm({ name: trimmed, botIds }).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : "Could not create channel");
            setSaving(false);
          });
        }}
      >
        <h2 id="new-channel-title" className="text-[17px] font-medium text-[#F1F1F2]">
          New channel
        </h2>
        <p className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          Every bot you add can read the channel, but a bot only replies when you @mention it by
          name.
        </p>
        <label className="mt-4 block text-[13.5px] text-[#C9C9CE]">
          Name
          <input
            ref={nameRef}
            maxLength={80}
            value={name}
            placeholder="general"
            onChange={(event) => setName(event.target.value)}
            className="mt-2 w-full rounded-[11px] border border-[#343438] bg-[#101012] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
        </label>
        <fieldset className="mt-4">
          <legend className="mb-2 text-[13.5px] text-[#C9C9CE]">Bots</legend>
          {bots.length === 0 ? (
            <p className="text-[13.5px] text-[#85858A]">
              You have no bots yet. Create the channel now and add bots later.
            </p>
          ) : (
            <div className="rk-scroll max-h-[220px] overflow-y-auto rounded-[11px] border border-[#343438]">
              {bots.map((bot) => (
                <label
                  key={bot.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-[#232327]"
                >
                  <input
                    type="checkbox"
                    checked={botIds.includes(bot.id)}
                    onChange={(event) =>
                      setBotIds((current) =>
                        event.target.checked
                          ? [...current, bot.id]
                          : current.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  <BotAvatar color={bot.color} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[#ECECEE]">
                    {bot.name}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error ? <p className="mt-3 text-[13.5px] text-[#FF5364]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded-[10px] bg-[#F1F1EF] px-3.5 py-2 text-[14px] font-medium text-[#17171A] disabled:opacity-40"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
