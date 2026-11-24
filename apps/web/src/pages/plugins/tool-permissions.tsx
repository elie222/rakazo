import { Trans, useLingui } from "@lingui/react/macro";
import type { AppPermissionTool, AppToolPermission } from "@rakazo/core";
import {
  approvalRuleApplies,
  appToolLabel,
  appToolRules,
  groupAppPermissionTools,
} from "@rakazo/core";
import type { SelectOption } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  OptionSelect,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

type Change = { key: string; permission: AppToolPermission };

export function ToolPermissions({ tools, slug }: { tools: AppPermissionTool[]; slug: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const rulesQuery = useQuery(queries.approvalRules.list.queryOptions({ input: {} }));
  const modeQuery = useQuery(queries.autoReview.get.queryOptions({ input: {} }));
  const rules = appToolRules(rulesQuery.data ?? []);
  const change = useSave({
    save: async ({ key, permission }: Change, rpc) => {
      if (permission === "default") {
        const rule = rules.get(key.toLowerCase());
        if (rule) await rpc.approvalRules.remove({ id: rule.id });
      } else {
        await rpc.approvalRules.set({ effect: permission, matchKind: "tool", matchValue: key });
      }
    },
    stale: [queries.approvalRules.list.key()],
  });
  const loadError = rulesQuery.error ?? modeQuery.error;
  const disabled =
    rulesQuery.isPending ||
    rulesQuery.isFetching ||
    modeQuery.isPending ||
    modeQuery.isFetching ||
    Boolean(loadError) ||
    change.pending;
  const mode = modeQuery.data?.mode;
  const options: SelectOption<AppToolPermission>[] = [
    { value: "default", label: t`Default` },
    {
      value: "always_allow",
      label: t`Allow`,
      disabled: !approvalRuleApplies(mode, "always_allow"),
    },
    {
      value: "require_approval",
      label: t`Ask`,
      disabled: !approvalRuleApplies(mode, "require_approval"),
    },
    { value: "deny", label: t`Block` },
  ];
  const { reads, writes } = groupAppPermissionTools(tools);
  const groups = [
    { key: "reads", title: t`Reads`, tools: reads },
    { key: "writes", title: t`Writes`, tools: writes },
  ].filter((group) => group.tools.length > 0);

  return (
    <section data-testid="connection-tools" className="space-y-2">
      <SectionHeading variant="label" className="px-2">
        <Trans>Tool permissions</Trans>
      </SectionHeading>
      {mode === "never" ? (
        <p className="px-2 text-body-sm text-muted-foreground">
          <Trans>Only Block rules apply in Never ask.</Trans>
        </p>
      ) : null}
      <div className="divide-y divide-border rounded-xl border border-border">
        {groups.map((group) => (
          <Collapsible key={group.key} className="group/tools">
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-2 text-start text-body font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/tools:rotate-90 motion-reduce:transition-none"
              />
              {group.title}
            </CollapsibleTrigger>
            <CollapsibleContent hiddenUntilFound>
              <ul className="space-y-0.5 px-3 pb-2">
                {group.tools.map((tool) => {
                  const key = tool.approvalKey;
                  const label = appToolLabel(tool.name, slug);
                  return (
                    <li key={key ?? tool.name} className="flex items-center gap-3 py-1 ps-5.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-sm text-foreground">{label}</div>
                        {tool.description !== tool.name && tool.description ? (
                          <div
                            className="truncate text-label text-muted-foreground"
                            title={tool.description}
                          >
                            {tool.description}
                          </div>
                        ) : null}
                      </div>
                      {key ? (
                        <OptionSelect
                          size="sm"
                          className="w-32 shrink-0"
                          aria-label={label}
                          value={rules.get(key.toLowerCase())?.effect ?? "default"}
                          options={options}
                          disabled={disabled}
                          onValueChange={(permission) => change.run({ key, permission })}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
      {change.error ? (
        <p role="alert" className="px-2 text-body-sm text-destructive">
          {errorText(change.error, t`Could not save permission`)}
        </p>
      ) : loadError ? (
        <p role="alert" className="px-2 text-body-sm text-destructive">
          {errorText(loadError, t`Could not load permissions`)}
        </p>
      ) : null}
    </section>
  );
}
