import { Trans, useLingui } from "@lingui/react/macro";
import { formatFileSize } from "@rakazo/core";
import { Skeleton } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { PagesList } from "../../../components/pages/PagesList";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { ArtifactMimeIcon } from "../../space/artifact-mime-icon";
import { PanelSection } from "./bot-settings-sections";

/** Recent files in the tab; more than this hands off to the Artifacts page. */
const PREVIEW_LIMIT = 12;

/**
 * The bot's library: pages it wrote (their own preview and whole list), then the files it made
 * or was sent. A file opens on the Artifacts page, which shows its versions and its download.
 */
export function BotLibrary({
  botId,
  botName,
  onOpenAllPages,
}: {
  botId: string;
  botName: string;
  onOpenAllPages: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const files = useQuery({
    ...queries.artifacts.listSpace.queryOptions({ input: { botId, limit: PREVIEW_LIMIT } }),
    refetchOnMount: "always",
  });
  const items = files.data?.items ?? [];

  return (
    <>
      <PagesList botId={botId} preview={{ onOpenAll: onOpenAllPages }} />
      <PanelSection
        label={
          files.data?.nextCursor ? (
            <Link
              to={`/app/artifacts?bot=${botId}`}
              className="flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trans>Files</Trans>
              <ChevronRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
            </Link>
          ) : (
            <Trans>Files</Trans>
          )
        }
      >
        {files.isError ? (
          <p className="text-body-sm text-destructive">
            {errorText(files.error, t`Could not load files`)}
          </p>
        ) : files.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-1 text-body-sm text-muted-foreground">
            <Trans>Files {botName} makes and receives show here.</Trans>
          </p>
        ) : (
          <ul data-testid="bot-library-files">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  to={`/app/artifacts/${item.id}?bot=${encodeURIComponent(botId)}`}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="shrink-0 text-muted-foreground">
                    <ArtifactMimeIcon mimeType={item.mimeType} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body" dir="auto">
                    {item.name}
                  </span>
                  <span className="shrink-0 text-body-sm text-muted-foreground">
                    {formatFileSize(item.size)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}
