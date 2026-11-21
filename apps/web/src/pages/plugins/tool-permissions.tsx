import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule, RpcOutput } from "@rakazo/contracts";
import { appToolLabel, connectorToolRequiresApproval } from "@rakazo/core";
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

type Tool = RpcOutput<"connections/tools">[number];
/** A tool's own rule, or none: whatever the approval mode does for its kind. */
type Permission = ActionApprovalRule["effect"] | "default";
type Change = { tools: Tool[]; permission: Permission };

/** An app's tools split into what only looks and what changes something, each with its rule. */
export function ToolPermissions({ tools, slug }: { tools: Tool[]; slug: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // No scope: the copy of the rules that applies here, the Space's when it customizes them.
  const rulesQuery = useQuery(queries.approvalRules.list.queryOptions({ input: {} }));
  const toolRules = new Map(
    (rulesQuery.data ?? [])
      .filter((rule) => rule.matchKind === "tool")
      .map((rule) => [rule.matchValue.toLowerCase(), rule]),
  );
  const permissionOf = (tool: Tool): Permission =>
    toolRules.get(tool.name.toLowerCase())?.effect ?? "default";
  const change = useSave({
    save: async ({ tools, permission }: Change, rpc) => {
      await Promise.all(
        tools.map((tool) => {
          const rule = toolRules.get(tool.name.toLowerCase());
          if (permission === "default") {
            return rule ? rpc.approvalRules.remove({ id: rule.id }) : undefined;
          }
          if (rule?.effect === permission) return undefined;
          return rpc.approvalRules.set({
            effect: permission,
            matchKind: "tool",
            matchValue: tool.name,
          });
        }),
      );
    },
    stale: [queries.approvalRules.list.key()],
  });
  const disabled = rulesQuery.isPending || Boolean(rulesQuery.error) || change.pending;
  const error = change.error
    ? errorText(change.error, t`Could not save permission`)
    : rulesQuery.error
      ? errorText(rulesQuery.error, t`Could not load permissions`)
      : null;
  const options: SelectOption<Permission>[] = [
    { value: "default", label: t`Default` },
    { value: "always_allow", label: t`Allow` },
    { value: "require_approval", label: t`Ask` },
    { value: "deny", label: t`Block` },
  ];
  const writes = tools.filter((tool) => connectorToolRequiresApproval(tool.name, tool.readOnly));
  const reads = tools.filter((tool) => !writes.includes(tool));
  const groups = [
    { key: "reads", title: t`Reads`, tools: reads },
    { key: "writes", title: t`Writes`, tools: writes },
  ].filter((group) => group.tools.length > 0);

  return (
    <section data-testid="connection-tools" className="space-y-2">
      <SectionHeading variant="label" className="px-2">
        <Trans>Tool permissions</Trans>
      </SectionHeading>
      <div className="divide-y divide-border rounded-xl border border-border">
        {groups.map((group) => {
          const shared = new Set(group.tools.map(permissionOf));
          const [only] = shared;
          return (
            <Collapsible
              key={group.key}
              data-testid={`connection-tools-${group.key}`}
              className="group/tools"
            >
              <div className="flex items-center gap-3 px-3 py-2">
                <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md py-1 text-start text-body font-medium text-foreground outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/tools:rotate-90 motion-reduce:transition-none"
                  />
                  {group.title}
                  <span className="font-normal text-muted-foreground">{group.tools.length}</span>
                </CollapsibleTrigger>
                <OptionSelect
                  size="sm"
                  className="w-32 shrink-0"
                  aria-label={t`${group.title} permission`}
                  value={shared.size === 1 && only ? only : null}
                  options={options}
                  disabled={disabled}
                  onValueChange={(permission) => change.run({ tools: group.tools, permission })}
                />
              </div>
              <CollapsibleContent hiddenUntilFound>
                <ul className="space-y-0.5 px-3 pb-2">
                  {group.tools.map((tool) => {
                    const label = appToolLabel(tool.name, slug);
                    return (
                      <li key={tool.name} className="flex items-center gap-3 py-1 ps-5.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body-sm text-foreground">{label}</div>
                          {tool.description && tool.description !== tool.name ? (
                            <div
                              className="truncate text-label text-muted-foreground"
                              title={tool.description}
                            >
                              {tool.description}
                            </div>
                          ) : null}
                        </div>
                        <OptionSelect
                          size="sm"
                          className="w-32 shrink-0"
                          aria-label={label}
                          value={permissionOf(tool)}
                          options={options}
                          disabled={disabled}
                          onValueChange={(permission) => change.run({ tools: [tool], permission })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
      {error ? <p className="px-2 text-body-sm text-destructive">{error}</p> : null}
    </section>
  );
}
