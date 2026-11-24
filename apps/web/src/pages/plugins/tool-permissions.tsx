import { Trans, useLingui } from "@lingui/react/macro";
import { APPROVAL_RULES_CHANGED } from "@rakazo/contracts";
import type { AppPermissionTool, AppToolPermissionChange } from "@rakazo/core";
import {
  appToolLabel,
  appToolPermissionChoices,
  appToolPermissionRequest,
  appToolRules,
  groupAppPermissionTools,
} from "@rakazo/core";
import { Disclosure, OptionSelect, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode, errorText } from "../../lib/query/user-error";

export function ToolPermissions({ tools, slug }: { tools: AppPermissionTool[]; slug: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const permissions = useQuery(queries.approvalRules.effective.queryOptions({ input: {} }));
  const snapshot = permissions.data;
  const rules = appToolRules(snapshot?.rules ?? []);
  const change = useSave({
    save: async (selection: AppToolPermissionChange, rpc) => {
      if (!snapshot) return;
      const request = appToolPermissionRequest(selection, rules, snapshot.target);
      if (request?.kind === "remove") await rpc.approvalRules.remove(request.input);
      if (request?.kind === "set") await rpc.approvalRules.set(request.input);
    },
    stale: [queries.approvalRules.effective.key(), queries.approvalRules.list.key()],
    onFailed: (error) => {
      if (errorCode(error) === APPROVAL_RULES_CHANGED) return permissions.refetch();
    },
  });
  const loadError = permissions.error;
  const disabled = !snapshot || permissions.isFetching || Boolean(loadError) || change.pending;
  const mode = snapshot?.mode;
  const labels = {
    default: t`Default`,
    always_allow: t`Allow`,
    require_approval: t`Ask`,
    deny: t`Block`,
  };
  const options = appToolPermissionChoices(mode).map(({ permission, disabled }) => ({
    value: permission,
    label: labels[permission],
    disabled,
  }));
  const { reads, other } = groupAppPermissionTools(tools);
  const groups = [
    { key: "reads", title: t`Reads`, tools: reads },
    { key: "other", title: t`Other actions`, tools: other },
  ].filter((group) => group.tools.length > 0);

  return (
    <section data-testid="connection-tools" className="group/tool-permissions space-y-2">
      <SectionHeading variant="label" className="px-2">
        <Trans>Tool permissions</Trans>
      </SectionHeading>
      <p className="hidden px-2 text-body-sm text-muted-foreground group-has-[[aria-expanded=true]]/tool-permissions:block">
        <Trans>Other approval rules still apply.</Trans>
      </p>
      {mode === "never" ? (
        <p className="px-2 text-body-sm text-muted-foreground">
          <Trans>Only Block rules apply in Never ask.</Trans>
        </p>
      ) : null}
      <div className="divide-y divide-border rounded-xl border border-border">
        {groups.map((group) => (
          <Disclosure
            key={group.key}
            summary={group.title}
            summaryClassName="w-full px-3 py-2 text-body font-medium"
          >
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
          </Disclosure>
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
