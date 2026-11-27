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
import { useRef } from "react";
import { useSave, useSpaceQueries } from "../query/query";
import { errorText } from "../query/user-error";

/** Reads and atomically toggles the account's starred `provider::modelId` keys. */
export function useStarredModels() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meQuery = queries.me.queryOptions();
  const me = useQuery(meQuery).data;
  const saved = normalizeStarredModelKeys(me?.chatPreferences?.starredModels);
  // Rapid clicks while a save is in flight queue here and drain one by one so none are dropped.
  const inFlightRef = useRef(false);
  const queueRef = useRef<StarredModelToggle[]>([]);
  const drainNext = () => {
    const next = queueRef.current.shift();
    if (next) save.run(next);
    else inFlightRef.current = false;
  };
  const save = useSave({
    save: async (starredModelToggle: StarredModelToggle, client) => {
      const updated = await client.preferences.update({
        chatPreferences: { starredModelToggle },
      });
      queryClient.setQueryData(meQuery.queryKey, updated);
      return updated;
    },
    stale: [queries.me.key()],
    onSaved: drainNext,
    onFailed: (error) => {
      toast.error(errorText(error, t`Could not update favorite models`));
      drainNext();
    },
  });

  let starredKeys = saved;
  if (save.pending && save.input) {
    starredKeys = applyStarredModelToggle(starredKeys, save.input.key, save.input.starred);
  }
  for (const queued of queueRef.current) {
    starredKeys = applyStarredModelToggle(starredKeys, queued.key, queued.starred);
  }

  function toggleStar(rawKey: string) {
    const parsed = parseModelOptionKey(rawKey.trim());
    if (!parsed) return;
    const key = modelOptionKey(parsed.provider, parsed.modelId);
    const nextStarred = !starredKeys.includes(key);
    if (nextStarred && starredKeys.length >= MAX_STARRED_MODELS) {
      toast.error(t`You can favorite up to ${MAX_STARRED_MODELS} models.`);
      return;
    }
    const toggle: StarredModelToggle = { key, starred: nextStarred };
    if (inFlightRef.current) {
      queueRef.current = [...queueRef.current.filter((entry) => entry.key !== key), toggle];
      return;
    }
    inFlightRef.current = true;
    save.run(toggle);
  }

  return {
    starredKeys,
    toggleStar,
    pending: save.pending,
  };
}
