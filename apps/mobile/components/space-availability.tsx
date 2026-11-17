import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";

type Space = { id: string; name: string };

/** The user's spaces; choosing where something is available only matters with two or more. */
export function useOwnSpaces(): Space[] {
  const { data } = useQuery(rpcQuery("spaces/list"), queryClient);
  return useMemo(() => (data?.spaces ?? []).map(({ id, name }) => ({ id, name })), [data]);
}

/** True when removing an item takes it from more than this one space. */
export function reachesOtherSpaces(availability: SpaceAvailability | undefined, spaces: number) {
  return spaces > 1 && Boolean(availability?.allSpaces || (availability?.spaceIds.length ?? 0) > 1);
}

/**
 * "Available in" as a native menu: every space, or exactly one. Several chosen spaces, set on
 * the web, show as they are and can be widened or narrowed here.
 */
export function SpaceAvailabilityPicker({
  kind,
  id,
  availability,
  stale,
}: {
  kind: AvailabilityKind;
  id: string;
  availability?: SpaceAvailability;
  /** The reads that show this item's availability. */
  stale: readonly QueryKey[];
}) {
  const { t } = useLingui();
  const spaces = useOwnSpaces();
  // A refused choice, such as a name already used in another space, says why; choosing again retries.
  const change = useSave({
    save: (next: { allSpaces: boolean; spaceIds: string[] }, send) =>
      send("availability/set", { kind, id, ...next }),
    stale,
  });
  const error = change.error
    ? errorText(change.error, t`Could not change where this is available`)
    : null;
  if (spaces.length < 2 || !availability) return null;
  const several = !availability.allSpaces && availability.spaceIds.length > 1;
  const value = availability.allSpaces ? "all" : several ? "several" : availability.spaceIds[0]!;
  const choices = [
    { key: "all", label: t`All spaces` },
    ...spaces.map((space) => ({ key: space.id, label: space.name })),
    ...(several
      ? [{ key: "several", label: t`${ph({ count: availability.spaceIds.length })} spaces` }]
      : []),
  ];
  return (
    <View>
      <MenuPicker
        label={t`Available in`}
        choices={choices}
        value={value}
        onChange={(key) => {
          if (key === value || key === "several") return;
          const next =
            key === "all"
              ? { allSpaces: true, spaceIds: availability.spaceIds }
              : { allSpaces: false, spaceIds: [key] };
          change.run(next);
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: mobileTokens().destructive, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
