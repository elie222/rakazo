import { useLingui } from "@lingui/react/macro";
import type { StarredModelToggle } from "@rakazo/contracts";
import { MAX_STARRED_MODELS } from "@rakazo/contracts";
import {
  applyStarredModelToggle,
  modelOptionKey,
  normalizeStarredModelKeys,
  parseModelOptionKey,
} from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSave, useSpaceQueries } from "../query/query";
import { errorText } from "../query/user-error";

function applyPendingToggles(
  saved: readonly string[],
  inFlight: StarredModelToggle | undefined,
  queued: readonly StarredModelToggle[],
): string[] {
  let keys = [...saved];
  if (inFlight) keys = applyStarredModelToggle(keys, inFlight.key, inFlight.starred);
  for (const item of queued) keys = applyStarredModelToggle(keys, item.key, item.starred);
  return keys;
}

/** Reads and atomically toggles the account's starred `provider::modelId` keys. */
export function useStarredModels() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meQuery = queries.me.queryOptions();
  const me = useQuery(meQuery).data;
  const saved = normalizeStarredModelKeys(me?.chatPreferences?.starredModels);
  // Queued toggles re-render immediately for optimistic feedback and drain through useSave.
  const [queue, setQueue] = useState<StarredModelToggle[]>([]);
  const queueRef = useRef<StarredModelToggle[]>(queue);
  queueRef.current = queue;

  const save = useSave({
    save: async (starredModelToggle: StarredModelToggle, client) => {
      const updated = await client.preferences.update({
        chatPreferences: { starredModelToggle },
      });
      queryClient.setQueryData(meQuery.queryKey, updated);
      return updated;
    },
    stale: [queries.me.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not update favorite models`)),
  });

  const inFlight = save.pending ? save.input : undefined;
  const starredKeys = applyPendingToggles(saved, inFlight, queue);

  useEffect(() => {
    if (save.pending || !queue.length) return;
    const [next, ...rest] = queue;
    if (!next) return;
    queueRef.current = rest;
    setQueue(rest);
    save.run(next);
  }, [save.pending, queue, save.run]);

  function toggleStar(rawKey: string) {
    const parsed = parseModelOptionKey(rawKey.trim());
    if (!parsed) return;
    const key = modelOptionKey(parsed.provider, parsed.modelId);
    const current = applyPendingToggles(saved, inFlight, queueRef.current);
    const nextStarred = !current.includes(key);
    if (nextStarred && current.length >= MAX_STARRED_MODELS) {
      toast.error(t`You can favorite up to ${MAX_STARRED_MODELS} models.`);
      return;
    }
    const nextQueue = [
      ...queueRef.current.filter((entry) => entry.key !== key),
      { key, starred: nextStarred },
    ];
    queueRef.current = nextQueue;
    setQueue(nextQueue);
  }

  return {
    starredKeys,
    toggleStar,
    pending: save.pending || queue.length > 0,
  };
}
