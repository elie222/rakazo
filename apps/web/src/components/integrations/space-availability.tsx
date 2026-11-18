import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** The user's spaces; choosing where something is available only matters with two or more. */
export function useOwnSpaces(): Array<{ id: string; name: string }> {
  const queries = useSpaceQueries();
  const spaces = useQuery(queries.spaces.list.queryOptions());
  return spaces.data?.spaces ?? [];
}

/** True when removing an item takes it from more than this one space. */
export function reachesOtherSpaces(
  availability: SpaceAvailability | undefined,
  spaceCount: number,
): boolean {
  return (
    spaceCount > 1 && Boolean(availability?.allSpaces || (availability?.spaceIds.length ?? 0) > 1)
  );
}

/** A muted note for list rows on items that are not available everywhere. */
export function AvailabilityLabel({ availability }: { availability?: SpaceAvailability }) {
  const spaces = useOwnSpaces();
  if (spaces.length < 2 || !availability || availability.allSpaces) return null;
  const only =
    availability.spaceIds.length === 1
      ? spaces.find((s) => s.id === availability.spaceIds[0])
      : null;
  return (
    <span className="shrink-0 text-body-sm text-muted-foreground">
      {only ? (
        only.name
      ) : (
        <Plural value={availability.spaceIds.length} one="# space" other="# spaces" />
      )}
    </span>
  );
}

/** "Available in" for one of the user's items, shown only to someone with several spaces. */
export function AvailabilityControl({
  kind,
  id,
  availability,
  onChanged,
}: {
  kind: AvailabilityKind;
  id: string;
  availability?: SpaceAvailability;
  onChanged: () => Promise<unknown> | unknown;
}) {
  const { t } = useLingui();
  const spaces = useOwnSpaces();
  const change = useSave({
    save: async (next: SpaceAvailability, rpc) => {
      await rpc.availability.set({ kind, id, ...next });
      await onChanged();
    },
  });
  const saving = change.pending;
  if (spaces.length < 2 || !availability) return null;
  const save = change.run;

  const chosen = availability.allSpaces ? spaces.map((space) => space.id) : availability.spaceIds;
  const summary = availability.allSpaces ? (
    <Trans>All spaces</Trans>
  ) : chosen.length === 1 ? (
    (spaces.find((space) => space.id === chosen[0])?.name ?? <Trans>1 space</Trans>)
  ) : (
    <Plural value={chosen.length} one="# space" other="# spaces" />
  );
  const toggle = (spaceId: string) => {
    const next = chosen.includes(spaceId)
      ? chosen.filter((other) => other !== spaceId)
      : [...chosen, spaceId];
    // At least one space keeps it; none would be removing it, which has its own action.
    if (!next.length) return;
    save({ allSpaces: false, spaceIds: next });
  };

  return (
    <div data-testid="availability" className="flex flex-wrap items-center gap-1 text-label">
      <span className="text-muted-foreground">
        <Trans>Available in</Trans>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              className="h-6 gap-1 px-1.5 text-label font-normal text-foreground"
            />
          }
        >
          {summary}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={availability.allSpaces}
            onCheckedChange={(checked) =>
              save(
                checked
                  ? { allSpaces: true, spaceIds: availability.spaceIds }
                  : { allSpaces: false, spaceIds: availability.spaceIds },
              )
            }
          >
            <Trans>All spaces</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {spaces.map((space) => (
            <DropdownMenuCheckboxItem
              key={space.id}
              checked={chosen.includes(space.id)}
              onCheckedChange={() => toggle(space.id)}
            >
              {space.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {change.error ? (
        <span role="alert" className="text-body-sm text-destructive">
          {errorText(change.error, t`Could not change where this is available`)}
        </span>
      ) : null}
    </div>
  );
}
