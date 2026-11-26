import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { Button, Skeleton } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";
import { AvailabilityLabel } from "../integrations/space-availability";
import { SkillPage, SkillSourceBadge } from "./skill-page";

const NO_SKILLS: AgentSkillCatalogEntry[] = [];

type Opened = { skillId: string } | { creating: true } | null;

/**
 * Your own skills in this space, plus the built-in ones; plugin skills are listed by plugin. A
 * skill opens as its own page, its files beside the one being read.
 */
export function AgentSkills({
  onOpenChange,
  onGuard,
}: {
  onOpenChange?: (open: boolean) => void;
  /** Receives the open skill's unsaved-changes check, or null when none is open. */
  onGuard?: (guard: ((go: () => void) => void) | null) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // The same list the composer offers as skill mentions, so a change here shows there at once.
  const listQuery = useQuery({
    ...queries.agentSkills.list.queryOptions(),
    refetchOnMount: "always",
  });
  const skills = (listQuery.data ?? NO_SKILLS).filter((skill) => skill.source !== "plugin");
  const [opened, setOpenedState] = useState<Opened>(null);
  const setOpened = (next: Opened) => {
    setOpenedState(next);
    onOpenChange?.(next !== null);
  };

  if (opened) {
    return (
      <SkillPage
        key={"skillId" in opened ? opened.skillId : "new"}
        skillId={"skillId" in opened ? opened.skillId : undefined}
        onBack={() => setOpened(null)}
        onCreated={(skillId) => setOpened({ skillId })}
        onDeleted={() => setOpened(null)}
        onGuard={onGuard}
      />
    );
  }

  return (
    <div data-testid="bot-knowledge-skills">
      {listQuery.isError ? (
        <div className="px-2.5 pb-2 text-body-sm text-destructive">{t`Could not load`}</div>
      ) : null}
      {listQuery.isPending ? <Skeleton className="h-10 w-full" /> : null}
      {!listQuery.isPending && !listQuery.isError && skills.length === 0 ? (
        <div className="px-2.5 py-1 text-body text-muted-foreground">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {skills.map((entry) => (
        <Button
          variant="ghost"
          key={entry.id}
          type="button"
          onClick={() => setOpened({ skillId: entry.id })}
          className="-mx-2.5 block h-auto w-[calc(100%+1.25rem)] justify-start px-2.5 py-2.5 text-start whitespace-normal"
        >
          <span className="flex w-full items-center justify-between gap-3">
            <span className="min-w-0 truncate text-body font-normal text-foreground" dir="auto">
              {entry.name}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <AvailabilityLabel availability={entry.availability} />
              <SkillSourceBadge source={entry.source} />
              <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
            </span>
          </span>
          <span className="mt-0.5 block truncate text-body-sm text-muted-foreground" dir="auto">
            {entry.description}
          </span>
        </Button>
      ))}
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpened({ creating: true })}
        className="-mx-2.5 mt-2 h-auto min-h-11 w-[calc(100%+1.25rem)] justify-between px-2.5 py-2.5 text-body font-normal text-foreground"
      >
        <Trans>New skill</Trans>
        <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}
