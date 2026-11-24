import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ChevronRight, Plus } from "lucide-react";
import { SettingsGroup } from "../../components/settings/SettingsRows";

/** Every Space this person can open, each by name, even when there is only one. */
export function SpacesSettingsPanel({
  spaces,
  onOpenSpace,
  onNewSpace,
}: {
  spaces: { id: string; name: string }[];
  onOpenSpace: (spaceId: string) => void;
  onNewSpace?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-8" data-testid="settings-spaces">
      <SettingsGroup>
        {spaces.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={t`Manage ${option.name}`}
            className="flex min-h-15 w-full items-center justify-between gap-4 px-4 py-3 text-start first:rounded-t-xl last:rounded-b-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => onOpenSpace(option.id)}
          >
            <span className="min-w-0 break-words text-body text-foreground">{option.name}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
            />
          </button>
        ))}
      </SettingsGroup>
      {onNewSpace ? (
        <Button variant="outline" className="rounded-full" onClick={onNewSpace}>
          <Plus />
          {t`New private space`}
        </Button>
      ) : null}
    </div>
  );
}
