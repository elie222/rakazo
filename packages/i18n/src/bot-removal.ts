import { ph, t } from "@lingui/core/macro";

export function botRemovalWarning(groups: readonly { name: string }[] | null): string {
  if (groups === null)
    return t`Groups left with fewer than two bots are deleted too, including their messages, files, and pages.`;
  if (groups.length === 0) return "";
  const names = groups.map((group) => group.name).join(", ");
  return groups.length === 1
    ? t`The group ${ph({ names })} will be deleted too, including its messages, files, and pages.`
    : t`The groups ${ph({ names })} will be deleted too, including their messages, files, and pages.`;
}
