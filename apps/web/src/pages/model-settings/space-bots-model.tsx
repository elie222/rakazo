import { Plural, Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
import { useCallback, useEffect, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";

/** Bots that pick their own model ignore the space default and its changes. */
export function botsWithOwnModel<T extends Pick<Bot, "modelProvider" | "modelId">>(
  bots: readonly T[],
): T[] {
  return bots.filter((bot) => Boolean(bot.modelProvider && bot.modelId));
}

/**
 * Lists the bots that ignore the space default and, after a confirm, moves them all onto
 * it, so a space-wide switch (say, after a subscription runs out) is one step.
 */
export function SpaceBotsModelNotice({ refreshKey }: { refreshKey?: unknown }) {
  const rpc = useSpaceRpc();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [moved, setMoved] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);

  const load = useCallback(() => {
    // A failed refresh keeps the last list, so a switch report stays on screen.
    void rpc.bots
      .list()
      .then(setBots)
      .catch(() => undefined);
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const pinned = bots ? botsWithOwnModel(bots) : [];

  async function switchAllToSpaceModel() {
    setPending(true);
    setMoved(0);
    setFailed([]);
    // Each bot saves on its own; any that fail are named and stay listed to retry.
    const results = await Promise.allSettled(
      pinned.map((bot) =>
        rpc.bots.update({ botId: bot.id, modelProvider: null, modelId: null, thinkingLevel: null }),
      ),
    );
    setMoved(results.filter((result) => result.status === "fulfilled").length);
    setFailed(
      pinned.filter((_, index) => results[index]?.status === "rejected").map((bot) => bot.name),
    );
    setPending(false);
    load();
  }

  if (!bots || (pinned.length === 0 && !moved && !failed.length)) return null;
  const failedNames = failed.join(", ");

  return (
    <section
      data-testid="space-bots-model"
      aria-labelledby="space-bots-model-title"
      className="mt-6 border-t border-border pt-5"
    >
      <h3 id="space-bots-model-title" className="text-[13.5px] text-muted-foreground">
        <Trans>Bot models</Trans>
      </h3>
      {pinned.length ? (
        <>
          <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
            <Plural
              value={pinned.length}
              one="# bot has its own model:"
              other="# bots have their own model:"
            />{" "}
            <span className="text-foreground">{pinned.map((bot) => bot.name).join(", ")}</span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            {pending ? <Trans>Switching…</Trans> : <Trans>Use space default</Trans>}
          </Button>
        </>
      ) : null}
      {moved ? (
        <p className="mt-2 text-[13px] leading-[1.5] text-success" role="status">
          <Plural
            value={moved}
            one="# bot now uses the space default."
            other="# bots now use the space default."
          />
        </p>
      ) : null}
      {failed.length ? (
        <p className="mt-2 text-[13px] leading-[1.5] text-destructive" role="alert">
          <Trans>Could not switch {failedNames}. Try again.</Trans>
        </p>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Plural
                value={pinned.length}
                one="Switch # bot to the space default?"
                other="Switch # bots to the space default?"
              />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Their own model is cleared. You can pick one again in each bot.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void switchAllToSpaceModel();
              }}
            >
              <Trans>Switch</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
