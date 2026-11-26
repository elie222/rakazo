import { useLingui } from "@lingui/react/macro";
import type { MediaModelOption, MediaModelRole, SettingsScope } from "@rakazo/contracts";
import { SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { spaceQueries, useSave } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import type { RoleModelOption } from "./role-model-picker";
import { RoleModelPicker, rolePickerTrigger } from "./role-model-picker";

const pickerOption = (option: MediaModelOption): RoleModelOption => ({
  provider: option.provider,
  providerName: option.connectionLabel,
  id: option.modelId,
  label: option.label,
  billing: "api_key",
  credentialId: option.credentialId,
});

/** The image and video models bots use, shown once one of the member's connections makes them. */
export function MediaModelSettings({
  userId,
  spaceId,
  scope,
  connectionIds,
}: {
  userId: string;
  spaceId: string;
  scope: SettingsScope;
  /** The member's connections, whose models these lists offer. */
  connectionIds: readonly string[];
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = spaceQueries(userId, spaceId);
  const input = { expectedUserId: userId, scope };
  const { data } = useQuery({
    queryKey: [...queries.models.media.queryKey({ input }), connectionIds],
    queryFn: () => rpc.models.media(input, { context: { spaceId } }),
  });
  const save = useSave({
    stale: [queries.models.media.key()],
    save: (choice: { role: MediaModelRole; option: MediaModelOption }, client) =>
      client.models.setMedia({
        role: choice.role,
        credentialId: choice.option.credentialId,
        modelId: choice.option.modelId,
        expectedUserId: userId,
        scope,
      }),
  });
  const titles: Record<MediaModelRole, string> = { image: t`Image model`, video: t`Video model` };
  return (["image", "video"] as const).map((role) => {
    const view = data?.[role];
    if (!view?.options.length) return null;
    const pending = save.pending && save.input?.role === role ? save.input.option : null;
    const shown =
      pending ??
      view.options.find(
        (option) =>
          option.credentialId === view.selected?.credentialId &&
          option.modelId === view.selected.modelId,
      );
    return (
      <section key={role} className="mb-8" data-testid={`model-role-${role}`}>
        <div className="mb-2.5 flex min-h-7 items-center">
          <SectionHeading variant="heading">{titles[role]}</SectionHeading>
        </div>
        <ol className="divide-y divide-border rounded-xl border border-border">
          <li className="flex min-h-[52px] items-center gap-2.5 py-2 ps-3 pe-2">
            <RoleModelPicker
              trigger={rolePickerTrigger(shown?.label ?? " ", shown?.connectionLabel)}
              label={t`Change ${titles[role]}`}
              options={view.options.map(pickerOption)}
              current={
                shown && {
                  provider: shown.provider,
                  modelId: shown.modelId,
                  credentialId: shown.credentialId,
                }
              }
              providers={[]}
              disabled={save.pending}
              onPick={(picked) => {
                const option = view.options.find(
                  (entry) =>
                    entry.credentialId === picked?.credentialId && entry.modelId === picked.id,
                );
                if (option) save.run({ role, option });
              }}
              onConnect={() => undefined}
            />
          </li>
        </ol>
        {save.error && save.input?.role === role ? (
          <p role="alert" className="mt-2 text-body text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </section>
    );
  });
}
