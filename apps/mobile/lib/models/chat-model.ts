import { t } from "@lingui/core/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { chatModelChoices, connectedModelChoices } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import type { MobileMe, MobileModel, MobileModelCredential } from "../api/mobile-types";

/** What a chat's model picker lists, with the space default named after its model. */
export function chatModelPickerChoices(
  me: MobileMe | null,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
  selectedKey: string,
): ChatModelChoice[] {
  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const spaceDefaultLabel = me?.defaultModel
    ? `${t`Space default`} (${defaultEntry?.label ?? me.defaultModel})`
    : t`Space default`;
  const choices = chatModelChoices(
    connectedModelChoices(credentials, catalog.map(localizeModelEntry)),
    selectedKey,
    spaceDefaultLabel,
    defaultEntry?.images,
  );
  choices[0] = {
    ...choices[0]!,
    title: t`Space default`,
    detail: me?.defaultModel ? (defaultEntry?.label ?? me.defaultModel) : undefined,
  };
  return choices;
}

function catalogEntry(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}
