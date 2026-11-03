import { Plural, Trans } from "@lingui/react/macro";
import type { McpServerHealth } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { Disclosure } from "@rakazo/ui-web";
import { CircleCheck, CircleDashed, LoaderCircle, TriangleAlert } from "lucide-react";
import { formatRelativeTime } from "../lib/relative-time";

/**
 * Primary status of a configured MCP server: whether the last launch/discovery worked.
 * Never colour-only: every state pairs an icon with text, and a failure carries its raw
 * log in a collapsed block so the card stays compact.
 */
export function McpServerHealthLine({
  health,
  checking = false,
}: {
  health: McpServerHealth;
  /** A Test connection run is in flight; shown until the server reports installing. */
  checking?: boolean;
}) {
  const toolCount = health.toolCount;
  const checked = health.checkedAt ? formatRelativeTime(health.checkedAt) : "";
  const checkedLabel = checked ? (
    <span className="font-normal text-muted-foreground">
      <Trans>Checked {checked}</Trans>
    </span>
  ) : null;

  if (checking && health.status !== "installing") {
    return (
      <p
        role="status"
        data-testid="mcp-health"
        data-status="checking"
        className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        <span>
          <Trans>Checking connection…</Trans>
        </span>
      </p>
    );
  }

  if (health.status === "installing") {
    return (
      <p
        role="status"
        data-testid="mcp-health"
        data-status="installing"
        className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        <span>
          <Trans>Installing…</Trans>
        </span>
      </p>
    );
  }

  if (health.status === "ok") {
    return (
      <p
        role="status"
        data-testid="mcp-health"
        data-status="ok"
        className="mt-2 flex items-center gap-1.5 text-xs font-medium text-success"
      >
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="flex flex-wrap gap-x-2">
          <Trans>Running</Trans>
          {toolCount === null ? null : (
            <span>
              <Plural value={toolCount} one="# tool" other="# tools" />
            </span>
          )}
          {checkedLabel}
        </span>
      </p>
    );
  }

  if (health.status === "error") {
    return (
      <div data-testid="mcp-health" data-status="error" className="mt-2">
        <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-destructive">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="flex flex-wrap gap-x-2">
            {health.code === MCP_OAUTH_CLIENT_REQUIRED ? (
              <Trans>Needs an OAuth client ID</Trans>
            ) : (
              <Trans>Not working</Trans>
            )}
            {checkedLabel}
          </span>
        </p>
        {health.message ? (
          <Disclosure
            data-testid="mcp-health-details"
            className="mt-1.5"
            summary={<Trans>Error details</Trans>}
            summaryClassName="text-[11px] text-muted-foreground"
          >
            <pre
              dir="ltr"
              className="rk-scroll mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-2 text-start font-mono text-[11px] leading-snug text-foreground wrap-anywhere"
            >
              {health.message}
            </pre>
          </Disclosure>
        ) : null}
      </div>
    );
  }

  return (
    <p
      role="status"
      data-testid="mcp-health"
      data-status="unknown"
      className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
    >
      <CircleDashed aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        <Trans>Not checked yet</Trans>
      </span>
    </p>
  );
}
