import type { AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";

type Space = { id: string; name: string };

/** The user's spaces; choosing where something is available only matters with two or more. */
export function useOwnSpaces(): Space[] {
  const [spaces, setSpaces] = useState<Space[]>([]);
  useEffect(() => {
    let live = true;
    rpc("spaces/list")
      .then((result) => {
        if (live) setSpaces(result.spaces.map(({ id, name }) => ({ id, name })));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return spaces;
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
  onChanged,
}: {
  kind: AvailabilityKind;
  id: string;
  availability?: SpaceAvailability;
  onChanged: () => unknown;
}) {
  const { t } = useI18n();
  const spaces = useOwnSpaces();
  const [error, setError] = useState<string | null>(null);
  if (spaces.length < 2 || !availability) return null;
  const several = !availability.allSpaces && availability.spaceIds.length > 1;
  const value = availability.allSpaces ? "all" : several ? "several" : availability.spaceIds[0]!;
  const choices = [
    { key: "all", label: t("All spaces") },
    ...spaces.map((space) => ({ key: space.id, label: space.name })),
    ...(several
      ? [{ key: "several", label: t("{count} spaces", { count: availability.spaceIds.length }) }]
      : []),
  ];
  return (
    <View>
      <MenuPicker
        label={t("Available in")}
        choices={choices}
        value={value}
        onChange={(key) => {
          if (key === value || key === "several") return;
          const next =
            key === "all"
              ? { allSpaces: true, spaceIds: availability.spaceIds }
              : { allSpaces: false, spaceIds: [key] };
          setError(null);
          // A refused choice, such as a name already used in another space, says why; choosing again retries.
          void rpc("availability/set", { kind, id, ...next })
            .then(onChanged)
            .catch((reason) =>
              setError(errorText(reason, t("Could not change where this is available"))),
            );
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
