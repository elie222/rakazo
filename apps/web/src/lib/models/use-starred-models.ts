import { useLingui } from "@lingui/react/macro";
import { MAX_STARRED_MODELS } from "@rakazo/contracts";
import { normalizeStarredModelKeys, toggleStarredModelKey } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSave, useSpaceQueries } from "../query/query";
import { errorText } from "../query/user-error";

/** Reads and updates the account's starred `provider::modelId` keys with optimistic state. */
export function useStarredModels() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meQuery = queries.me.queryOptions();
  const me = useQuery(meQuery).data;
  const saved = normalizeStarredModelKeys(me?.chatPreferences?.starredModels);
  const save = useSave({
    save: async (starredModels: string[], client) => {
      const updated = await client.preferences.update({
        chatPreferences: { starredModels },
      });
      queryClient.setQueryData(meQuery.queryKey, updated);
      return updated;
    },
    stale: [queries.me.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not update favorite models`)),
  });
  const starredKeys = save.pending && save.input ? save.input : saved;

  function toggleStar(key: string) {
    const next = toggleStarredModelKey(starredKeys, key);
    if (next.length > MAX_STARRED_MODELS) {
      toast.error(t`You can favorite up to ${MAX_STARRED_MODELS} models.`);
      return;
    }
    save.run(next);
  }

  return {
    starredKeys,
    toggleStar,
    pending: save.pending,
  };
}
