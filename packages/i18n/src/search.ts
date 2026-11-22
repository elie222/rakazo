import { t } from "@lingui/core/macro";
import type { SearchHit } from "@rakazo/contracts";

/** What kind of result a search hit is, shown beside its title. */
export function searchKindLabel(hit: SearchHit): string {
  switch (hit.kind) {
    case "conversation":
      return hit.groupId ? t`Group` : t`Bot`;
    case "message":
      return t`Message`;
    case "file":
      return t`File`;
    case "link":
      return t`Link`;
    case "routine":
      return t`Routine`;
  }
}
