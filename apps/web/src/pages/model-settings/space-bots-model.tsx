import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { botsWithOwnModel } from "@rakazo/core";
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "@rakazo/ui-web";
import { Bot as BotIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";

/**
 * Bots that ignore the main model. They stay out of sight behind a small icon by the
 * heading, and come up as a toast when the main model changes and they would not follow,
 * so a space-wide switch (say, after a subscription runs out) is still one step.
 */
export function SpaceBotsModelButton({ mainModelKey }: { mainModelKey: string }) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const shownKey = useRef<string | null>(null);

  const load = useCallback(
    () =>
      rpc.bots
        .list()
        .then((next) => {
          setBots(next);
          return next;
        })
        .catch(() => null),
    [rpc],
  );

  const pinned = bots ? botsWithOwnModel(bots) : [];

  const switchAll = useCallback(
    async (targets: Bot[]) => {
      setPending(true);
      // Each bot saves on its own; any that fail are named and stay listed to retry.
      const results = await Promise.allSettled(
        targets.map((bot) =>
          rpc.bots.update({
            botId: bot.id,
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
          }),
        ),
      );
      setPending(false);
      setOpen(false);
      const failed = targets.filter((_, index) => results[index]?.status === "rejected");
      if (failed.length) {
        const failedNames = failed.map((bot) => bot.name).join(", ");
        toast.error(t`Could not switch ${failedNames}. Try again.`);
      }
      await load();
    },
    [load, rpc, t],
  );

  useEffect(() => {
    // The first load is what was already there; later ones follow a main model change.
    const changed = shownKey.current !== null && shownKey.current !== mainModelKey;
    shownKey.current = mainModelKey;
    void load().then((next) => {
      const stay = next ? botsWithOwnModel(next) : [];
      if (!changed || !stay.length) return;
      const names = stay.map((bot) => bot.name).join(", ");
      toast(
        stay.length === 1 ? t`${names} keeps its own model` : t`${names} keep their own model`,
        {
          id: "space-bots-model",
          action: { label: t`Use main model`, onClick: () => void switchAll(stay) },
        },
      );
    });
  }, [load, mainModelKey, switchAll, t]);

  if (!pinned.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="space-bots-model"
        aria-label={t`Bots with their own model`}
        render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}
      >
        <BotIcon aria-hidden />
        {pinned.length}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="px-1 text-label text-muted-foreground">{t`Bots with their own model`}</p>
        <ul className="text-body-sm">
          {pinned.map((bot) => (
            <li key={bot.id} className="truncate px-1 py-1">
              {bot.name}
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void switchAll(pinned)}
        >
          {pending ? t`Switching…` : t`Use main model`}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
