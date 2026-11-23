import { useLingui } from "@lingui/react/macro";
import type { MediaModelRole, SettingsScope } from "@rakazo/contracts";
import { OptionSelect, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { spaceQueries, useSave } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";

const choiceKey = (choice: { credentialId: string; modelId: string }) =>
  JSON.stringify([choice.credentialId, choice.modelId]);

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
    save: (choice: { role: MediaModelRole; key: string }, client) => {
      const [credentialId, modelId] = JSON.parse(choice.key) as [string, string];
      return client.models.setMedia({
        role: choice.role,
        credentialId,
        modelId,
        expectedUserId: userId,
        scope,
      });
    },
  });
  const titles: Record<MediaModelRole, string> = { image: t`Image model`, video: t`Video model` };
  return (["image", "video"] as const).map((role) => {
    const view = data?.[role];
    if (!view?.options.length) return null;
    const pending = save.pending && save.input?.role === role ? save.input.key : null;
    return (
      <section key={role} className="mb-8" data-testid={`model-role-${role}`}>
        <SectionHeading variant="heading" className="mb-2.5">
          {titles[role]}
        </SectionHeading>
        <OptionSelect
          value={pending ?? (view.selected ? choiceKey(view.selected) : null)}
          options={view.options.map((option) => ({
            value: choiceKey(option),
            label: option.label,
          }))}
          onValueChange={(key) => save.run({ role, key })}
          disabled={save.pending}
          aria-label={titles[role]}
        />
        {save.error && save.input?.role === role ? (
          <p role="alert" className="mt-2 text-body text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </section>
    );
  });
}
